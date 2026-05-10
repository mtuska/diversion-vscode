import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runDv, runDvOrThrow } from './cli.js';
import { listFilesRecursive } from '../util/walk.js';
import { parseStatus, type ParsedStatus } from './parsers/status.js';
import { parseDiffNameStatus } from './parsers/diffNameStatus.js';
import { parseBranchList, type BranchInfo } from './parsers/branch.js';
import { parseLogOneline, parseLogFull, type CommitSummary, type CommitDetails } from './parsers/log.js';
import { parseLockList, type LockInfo } from './parsers/lock.js';
import { parseShelfList, type ShelfInfo } from './parsers/shelf.js';
import { parseAnnotation, type Annotation } from './parsers/annotate.js';
import { findSyncConflicts, type SyncConflict } from './conflicts.js';
import type { DaemonClient } from './daemon.js';
import type {
  FileChange,
  RepoIdentity,
  WorkspaceSyncProgress,
  WorkspaceSyncStatus,
} from './types.js';
import type { Logger } from '../util/log.js';

export interface RepoState {
  identity: RepoIdentity;
  changes: FileChange[];
  status: ParsedStatus;
  conflicts: SyncConflict[];
}

/**
 * Maximum commit-message length `dv` accepts. Anything longer is
 * rejected by the daemon at commit time, so we validate up front and
 * surface a clear error rather than letting the user wait through a
 * long-running commit only to see a generic dv failure.
 */
export const MAX_COMMIT_MESSAGE_LEN = 16384;

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
          tier: ws.OrganizationTier,
        });
      }
    } catch (err) {
      this.logger.warn(`Daemon refresh failed for ${this.identity.repoName}: ${(err as Error).message}`);
    }
    return this.identity;
  }

  /**
   * AgentAPI sync state — answers "is this workspace caught up?" without
   * us having to text-parse `dv status`. Returns `undefined` if the
   * agent is unreachable so callers can fall back gracefully.
   */
  async syncStatus(): Promise<WorkspaceSyncStatus | undefined> {
    try {
      return await this.daemon.syncStatus(this.identity.repoId, this.identity.workspaceId);
    } catch (err) {
      this.logger.debug(`syncStatus failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * AgentAPI live sync activity — bytes transferred per direction,
   * queue size, current action. Polled by the status bar while a sync
   * is in flight. Returns `undefined` if the agent is unreachable or
   * the workspace isn't actively syncing.
   */
  async syncProgress(): Promise<WorkspaceSyncProgress | undefined> {
    try {
      return await this.daemon.syncProgress(this.identity.repoId, this.identity.workspaceId);
    } catch (err) {
      this.logger.debug(`syncProgress failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Wake the agent to pick up a change we *know* just landed (e.g.
   * right after a commit), shortening the time before `/sync` reports
   * the new state. Best-effort: errors are swallowed so callers don't
   * have to wrap each call in try/catch.
   */
  async notifySyncRequired(): Promise<void> {
    try {
      await this.daemon.notifySyncRequired(this.identity.repoId, this.identity.workspaceId);
    } catch (err) {
      this.logger.debug(`notifySyncRequired failed: ${(err as Error).message}`);
    }
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
    changes = changes.filter((c) => !/\.dv-conflict(?:-\d+)?(?:\.[^./\\]+)?$/.test(c.path));

    // dv reports new directories as a single entry (e.g. `Plugins/Foo`).
    // Expand each one to its constituent files so the SCM panel's list view
    // shows files (matching git's UX). Tree view still works because VS Code
    // derives the tree from the file paths themselves.
    changes = await this.expandAddedDirectories(changes);
    changes = sortChanges(changes);

    return { identity: this.identity, changes, status, conflicts };
  }

  private async expandAddedDirectories(changes: FileChange[]): Promise<FileChange[]> {
    // dv lists ancestor directories alongside individual files when it
    // already enumerated the file children itself (the common case — `dv
    // status` printed the dir + files together). For those directory
    // entries we do nothing: skip the dir, let the file entries pass
    // through. .dvignore is honored automatically because dv applied it
    // when producing the listing.
    //
    // Only when dv listed a "new" directory WITHOUT enumerating any files
    // inside (typical for a freshly-dropped subtree with no committed
    // siblings) do we walk the disk to populate file entries — an
    // intentional trade-off because we'd otherwise show a single un-
    // commit-able folder row and the user would have nothing to act on.
    const addedPaths = changes
      .filter((c) => c.kind === 'added')
      .map((c) => c.path);
    const sep = path.sep;
    const hasAddedDescendant = (parentRel: string): boolean => {
      const prefix = parentRel.endsWith(sep) ? parentRel : parentRel + sep;
      const altPrefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
      return addedPaths.some(
        (p) => p !== parentRel && (p.startsWith(prefix) || p.startsWith(altPrefix)),
      );
    };

    const out: FileChange[] = [];
    const seenAdded = new Set<string>();
    const emitAdded = (relPath: string): void => {
      if (seenAdded.has(relPath)) return;
      seenAdded.add(relPath);
      out.push({ kind: 'added', path: relPath });
    };

    for (const change of changes) {
      if (change.kind !== 'added') {
        out.push(change);
        continue;
      }
      const abs = path.join(this.identity.workspacePath, change.path);
      let stat: import('node:fs').Stats | undefined;
      try { stat = await fs.stat(abs); } catch { /* path no longer present */ }
      if (!stat?.isDirectory()) {
        emitAdded(change.path);
        continue;
      }
      if (hasAddedDescendant(change.path)) {
        // dv already listed file children — they'll be emitted by their
        // own iteration. Drop the directory entry itself.
        continue;
      }
      // No file children in dv's output — fall back to a disk walk to
      // populate the panel. Caveat: anything `.dvignore`d inside this
      // subtree won't be filtered (we don't read .dvignore ourselves).
      const files = await listFilesRecursive(abs);
      for (const file of files) {
        emitAdded(path.relative(this.identity.workspacePath, file));
      }
    }
    return out;
  }

  async commit(message: string, paths?: readonly string[]): Promise<void> {
    if (message.length > MAX_COMMIT_MESSAGE_LEN) {
      throw new Error(
        `Commit message is ${message.length} characters; ` +
        `dv accepts at most ${MAX_COMMIT_MESSAGE_LEN}.`,
      );
    }
    const args: string[] = paths && paths.length > 0
      ? ['commit', ...paths, '-m', message]
      : ['commit', '-a', '-m', message];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /**
   * Full unified diff of the working tree against the base commit. If
   * `paths` is provided the diff is scoped to just those paths, matching
   * how `dv commit <paths>` is scoped. Used by the "generate commit
   * message" feature to feed an LLM only the relevant patch.
   */
  async unifiedDiff(paths?: readonly string[]): Promise<string> {
    const args = ['diff', '--color', 'never', ...(paths && paths.length > 0 ? paths : [])];
    const r = await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000 });
    return r.stdout;
  }

  async discardPath(path: string): Promise<void> {
    // `-f` skips the interactive confirmation dv otherwise waits on. Without
    // it `dv reset <path>` blocks indefinitely when run without a TTY (which
    // is exactly how we run it from the extension), making the command a
    // silent no-op.
    await runDvOrThrow(['reset', path, '-f'], { cwd: this.root, dvPath: this.dvPath });
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

  /** Per-line attribution for a workspace-relative path. */
  async annotate(relPath: string): Promise<Annotation[]> {
    const r = await runDvOrThrow(['annotate', relPath], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000,
    });
    return parseAnnotation(r.stdout);
  }

  /** File changes introduced by a single commit. */
  async fileChangesForCommit(commitId: string): Promise<FileChange[]> {
    const r = await runDvOrThrow(
      ['show', commitId, '--name-status', '--color', 'never'],
      { cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000 },
    );
    return parseDiffNameStatus(r.stdout);
  }

  /** Cherry-pick a commit's changes into the current workspace. */
  async cherryPick(commitId: string): Promise<void> {
    await runDvOrThrow(['cherry-pick', commitId], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /** Revert the changes of a past commit (creates a new commit that inverts it). */
  async revertCommit(commitId: string, conflictResolution?: 'manual' | 'keep-current' | 'accept-incoming'): Promise<void> {
    const args = ['revert', commitId];
    if (conflictResolution) args.push('--conflict_resolution', conflictResolution);
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /** Set the workspace contents to match the given commit (does not rewrite history). */
  async revertToCommit(commitId: string): Promise<void> {
    await runDvOrThrow(['revert-to-commit', commitId], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /** Restore a single file from a ref into the workspace. */
  async restorePath(ref: string, relPath: string): Promise<void> {
    await runDvOrThrow(['restore', relPath, '--source', ref], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  // ───── shelves ─────

  async listShelves(): Promise<ShelfInfo[]> {
    const r = await runDvOrThrow(['shelf'], { cwd: this.root, dvPath: this.dvPath });
    return parseShelfList(r.stdout);
  }

  /**
   * Create a shelf from the current workspace changes.
   * @param paths   workspace-relative paths to shelve. Empty/undefined = all changes.
   * @param keepWorkingChanges  if true, pass --no-reset to keep working tree intact.
   */
  async createShelf(name: string, paths?: readonly string[], keepWorkingChanges = false): Promise<void> {
    const args = ['shelf', 'create', name];
    if (paths && paths.length > 0) args.push(...paths);
    if (keepWorkingChanges) args.push('--no-reset');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async applyShelf(shelf: string, keepShelfAfter = false): Promise<void> {
    const args = ['shelf', 'apply', shelf, '-f'];
    if (keepShelfAfter) args.push('--keep');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async deleteShelf(shelf: string): Promise<void> {
    await runDvOrThrow(['shelf', 'delete', shelf, '-f'], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
  }

  async renameShelf(shelf: string, newName: string): Promise<void> {
    await runDvOrThrow(['shelf', 'rename', shelf, newName], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
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
