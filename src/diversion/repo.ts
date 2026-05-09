import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { runDv, runDvOrThrow } from './cli.js';
import { parseStatus, type ParsedStatus } from './parsers/status.js';
import { parseDiffNameStatus } from './parsers/diffNameStatus.js';
import { parseBranchList, type BranchInfo } from './parsers/branch.js';
import { parseLogOneline, parseLogFull, type CommitSummary, type CommitDetails } from './parsers/log.js';
import { parseLockList, type LockInfo } from './parsers/lock.js';
import { findSyncConflicts, type SyncConflict } from './conflicts.js';
import type { DaemonClient } from './daemon.js';
import type { FileChange, RepoIdentity } from './types.js';
import type { Logger } from '../util/log.js';

export interface RepoState {
  identity: RepoIdentity;
  changes: FileChange[];
  status: ParsedStatus;
  conflicts: SyncConflict[];
}

/**
 * High-level operations on a single Diversion workspace. Wraps the CLI runner
 * and merges in daemon-sourced identity so status-bar / detection callers
 * don't always have to shell out.
 */
export class Repo {
  constructor(
    private readonly daemon: DaemonClient,
    private readonly identity: RepoIdentity,
    private readonly dvPath: string | undefined,
    private readonly logger: Logger,
  ) {}

  get root(): string { return this.identity.workspacePath; }
  get info(): RepoIdentity { return this.identity; }
  /** The dv binary path used for this repo, or undefined to use PATH lookup. */
  get binaryPath(): string | undefined { return this.dvPath; }

  /** Refresh the cached identity from the daemon (branch/commit/paused state). */
  async refreshIdentity(): Promise<RepoIdentity> {
    try {
      const all = await this.daemon.workspaces();
      const ws = all[this.identity.workspaceId];
      if (ws) {
        Object.assign(this.identity, {
          branchId: ws.BranchID,
          branchName: ws.BranchName,
          commitId: ws.CommitID,
          paused: ws.Paused,
          readOnly: ws.ReadOnly,
        });
      }
    } catch (err) {
      this.logger.warn(`Daemon refresh failed for ${this.identity.repoName}: ${(err as Error).message}`);
    }
    return this.identity;
  }

  /**
   * Pull working-tree state. Uses `dv diff --name-status` as the primary
   * source for changed paths and `dv status` for header info (sync state,
   * totals). Both are run in parallel, alongside a fast workspace scan for
   * `*.dv-conflict*` sidecar files.
   */
  async getState(token?: vscode.CancellationToken): Promise<RepoState> {
    const [statusResult, diffResult, conflicts] = await Promise.all([
      runDvOrThrow(['status'], { cwd: this.root, dvPath: this.dvPath, token }),
      runDvOrThrow(['diff', '--name-status', '--color', 'never'], {
        cwd: this.root, dvPath: this.dvPath, token,
      }),
      findSyncConflicts(this.root),
    ]);
    const status = parseStatus(statusResult.stdout);
    let changes = parseDiffNameStatus(diffResult.stdout);

    // `dv diff --name-status` only reports tracked changes — new files show as
    // 'A' in some dv versions but as a status-only "New:" entry in others.
    // Merge in any "New:" paths from `dv status` that the diff didn't surface.
    const knownPaths = new Set(changes.map((c) => c.path));
    for (const c of status.changes) {
      if (c.kind === 'added' && !knownPaths.has(c.path)) changes.push(c);
    }
    // Strip `.dv-conflict*` sidecars from the change list — they aren't
    // actually tracked and they get their own dedicated group.
    changes = sortChanges(changes.filter((c) => !/\.dv-conflict(?:-\d+)?(?:\.[^./\\]+)?$/.test(c.path)));

    return { identity: this.identity, changes, status, conflicts };
  }

  async commit(message: string, paths?: readonly string[]): Promise<void> {
    const args: string[] = paths && paths.length > 0
      ? ['commit', ...paths, '-m', message]
      : ['commit', '-a', '-m', message];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async discardPath(path: string): Promise<void> {
    await runDvOrThrow(['reset', path], { cwd: this.root, dvPath: this.dvPath });
  }

  async discardAll(includeNew: boolean): Promise<void> {
    const args = ['reset', '--all', '-f', ...(includeNew ? ['--clean'] : [])];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath });
  }

  async listBranches(): Promise<BranchInfo[]> {
    const r = await runDvOrThrow(['branch'], { cwd: this.root, dvPath: this.dvPath });
    return parseBranchList(r.stdout);
  }

  async createBranch(name: string, switchTo = true): Promise<void> {
    const args = ['branch', '-c', name, ...(switchTo ? [] : ['--no-checkout'])];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async checkout(ref: string, opts: {
    takeChanges?: boolean;
    shelveChanges?: boolean;
    discardChanges?: boolean;
  } = {}): Promise<void> {
    const flags: string[] = [];
    if (opts.takeChanges) flags.push('--take-changes');
    if (opts.shelveChanges) flags.push('--shelve-changes');
    if (opts.discardChanges) flags.push('--discard-changes');
    await runDvOrThrow(['checkout', ref, ...flags], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  async merge(ref: string): Promise<void> {
    await runDvOrThrow(['merge', ref], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async logOneline(limit = 50): Promise<CommitSummary[]> {
    const r = await runDvOrThrow(['log', '-n', String(limit), '--oneline'], {
      cwd: this.root, dvPath: this.dvPath,
    });
    return parseLogOneline(r.stdout);
  }

  async logFull(limit = 20): Promise<CommitDetails[]> {
    const r = await runDvOrThrow(['log', '-n', String(limit), '--date', 'iso'], {
      cwd: this.root, dvPath: this.dvPath,
    });
    return parseLogFull(r.stdout);
  }

  /**
   * Open the workspace in the Diversion web UI. Spawns and forgets — the
   * CLI exits as soon as the browser has been signaled.
   */
  async openInWeb(): Promise<void> {
    await runDv(['view'], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 5_000 });
  }

  /** Pause background sync for this workspace (like running offline). */
  async pauseSync(): Promise<void> {
    await runDvOrThrow(['workspace', 'pause'], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
  }

  /** Resume background sync. */
  async resumeSync(): Promise<void> {
    await runDvOrThrow(['workspace', 'resume'], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
  }

  /** Force-pull the workspace's base branch (manual update when auto-update is off). */
  async updateWorkspace(): Promise<void> {
    await runDvOrThrow(['update'], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /** Validate local repository integrity. */
  async verify(): Promise<string> {
    const r = await runDvOrThrow(['verify'], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
    return r.stdout;
  }

  /** List all hard locks visible to this workspace. Cached briefly. */
  async listLocks(): Promise<LockInfo[]> {
    if (this.locksCache && Date.now() - this.locksCacheAt < 5_000) {
      return this.locksCache;
    }
    const r = await runDvOrThrow(['lock'], { cwd: this.root, dvPath: this.dvPath });
    const locks = parseLockList(r.stdout);
    this.locksCache = locks;
    this.locksCacheAt = Date.now();
    return locks;
  }

  /** Acquire a hard lock on the given path. */
  async lockPath(relPath: string): Promise<void> {
    await runDvOrThrow(['lock', relPath], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
    this.locksCache = undefined;
  }

  /** Release a lock on the given path. */
  async unlockPath(relPath: string): Promise<void> {
    await runDvOrThrow(['lock', '-d', relPath], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
    this.locksCache = undefined;
  }

  /** Drop the lock cache (call after potentially state-changing operations). */
  invalidateLockCache(): void {
    this.locksCache = undefined;
  }

  private locksCache: LockInfo[] | undefined;
  private locksCacheAt = 0;
}

export async function deleteSidecar(sidecarPath: string): Promise<void> {
  await fs.unlink(sidecarPath);
}

function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}
