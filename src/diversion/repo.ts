import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runDv, runDvOrThrow, type CancellationLike } from './cli.js';
import { safeRepoPath, safeRef } from './argGuard.js';
import { listFilesRecursive } from '../util/walk.js';
import { CoreApiClient } from './coreApi.js';
import { parseStatus, type ParsedStatus } from './parsers/status.js';
import { parseDiffNameStatus } from './parsers/diffNameStatus.js';
import { parseLockList, type LockInfo } from './parsers/lock.js';
import { parseAnnotation, type Annotation } from './parsers/annotate.js';
import { parseTagList, type TagInfo } from './parsers/tag.js';
import { findSyncConflicts, type SyncConflict } from './conflicts.js';
import type { DaemonClient } from './daemon.js';
import type {
  BranchInfo,
  CommitDetails,
  CommitSummary,
  FileChange,
  OpenMerge,
  RepoIdentity,
  RepoListEntry,
  ShelfInfo,
  WorkspaceSyncProgress,
  WorkspaceSyncStatus,
} from './types.js';
import type { LoggerLike } from '../util/logCore.js';

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
  private coreClient: CoreApiClient | undefined;

  constructor(
    private readonly daemon: DaemonClient,
    private readonly identity: RepoIdentity,
    private dvPath: string | undefined,
    private readonly logger: LoggerLike,
    private readonly coreApiUrl?: string,
  ) {}

  /** Lazily-constructed CoreAPI client (auth via the local agent token). */
  private get core(): CoreApiClient {
    if (!this.coreClient) {
      this.coreClient = new CoreApiClient(this.daemon, this.logger, {
        ...(this.coreApiUrl ? { baseUrl: this.coreApiUrl } : {}),
      });
    }
    return this.coreClient;
  }

  get root(): string { return this.identity.workspacePath; }
  get info(): RepoIdentity { return this.identity; }
  /** The dv binary path used for this repo, or undefined to use PATH lookup. */
  get binaryPath(): string | undefined { return this.dvPath; }
  /**
   * Update the dv binary path at runtime. Called when the user edits
   * `diversion.path` mid-session — without this, existing repos keep
   * trying to spawn whatever was configured at activation time.
   */
  setBinaryPath(next: string | undefined): void {
    if (this.dvPath === next) return;
    this.logger.info(`[repo] dv binary path → ${next ?? '(system PATH lookup)'}`);
    this.dvPath = next;
  }

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
    // Cached briefly: the status bar calls this on every active-editor change,
    // which would otherwise be one daemon round-trip per tab switch.
    if (this.syncStatusCache !== undefined && Date.now() - this.syncStatusAt < 2_000) {
      return this.syncStatusCache;
    }
    try {
      const s = await this.daemon.syncStatus(this.identity.repoId, this.identity.workspaceId);
      this.syncStatusCache = s;
      this.syncStatusAt = Date.now();
      return s;
    } catch (err) {
      this.logger.debug(`syncStatus failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private syncStatusCache: WorkspaceSyncStatus | undefined;
  private syncStatusAt = 0;

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
   * Pull working-tree state. Uses local `dv status` + `dv diff --name-status`
   * for the changelist — this reads the *local working tree*, so a just-edited
   * file appears immediately. (The CoreAPI `get_status` endpoint reflects the
   * cloud's view, which lags by a sync roundtrip, so it's unfit for the
   * refresh hot path.) Runs alongside a fast scan for `*.dv-conflict*`
   * sidecar files.
   */
  async getState(token?: CancellationLike): Promise<RepoState> {
    const [statusResult, diffResult, conflicts] = await Promise.all([
      runDvOrThrow(['status'], { cwd: this.root, dvPath: this.dvPath, token }),
      runDvOrThrow(['diff', '--name-status', '--color', 'never'], {
        cwd: this.root, dvPath: this.dvPath, token,
      }),
      this.ensureConflicts(),
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
    const addedChanges = changes.filter((c) => c.kind === 'added');
    if (addedChanges.length === 0) return changes;

    const sep = path.sep;
    // Directories that have at least one added descendant. Built in O(total
    // path length) by recording every ancestor prefix of each added path —
    // replaces the previous O(n²) `addedPaths.some(startsWith)` scan that was
    // re-run per directory entry (10⁸ string ops on a 10k-file added tree).
    const parentsWithAddedDescendant = new Set<string>();
    for (const c of addedChanges) {
      const p = c.path;
      for (let i = 0; i < p.length; i++) {
        if (p[i] === '/' || p[i] === sep) parentsWithAddedDescendant.add(p.slice(0, i));
      }
    }

    // Stat the leaf added entries in bounded-parallel batches instead of one
    // serial `await fs.stat` each. Directories dv already enumerated (those in
    // the descendant set) need no stat — we skip them outright.
    const toStat = addedChanges.filter((c) => !parentsWithAddedDescendant.has(c.path));
    const statByPath = new Map<string, import('node:fs').Stats | undefined>();
    await mapWithConcurrency(toStat, 16, async (change) => {
      const abs = path.join(this.identity.workspacePath, change.path);
      try { statByPath.set(change.path, await fs.stat(abs)); }
      catch { statByPath.set(change.path, undefined); /* path no longer present */ }
    });

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
      if (parentsWithAddedDescendant.has(change.path)) {
        // dv already listed file children — they'll be emitted by their
        // own iteration. Drop the directory entry itself.
        continue;
      }
      const stat = statByPath.get(change.path);
      if (!stat?.isDirectory()) {
        emitAdded(change.path);
        continue;
      }
      // A directory dv listed WITHOUT enumerating any children — fall back to
      // a disk walk to populate the panel. Caveat: anything `.dvignore`d
      // inside this subtree won't be filtered (we don't read .dvignore here).
      const abs = path.join(this.identity.workspacePath, change.path);
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
      ? ['commit', ...paths.map((p) => safeRepoPath(this.root, p)), '-m', message]
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
    const args = ['diff', '--color', 'never',
      ...(paths && paths.length > 0 ? paths.map((p) => safeRepoPath(this.root, p)) : [])];
    const r = await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000 });
    return r.stdout;
  }

  /** Unified diff between two refs (commits / branches / tags). */
  async diffBetween(base: string, compare: string): Promise<string> {
    const r = await runDvOrThrow(
      ['diff', '--color', 'never', '--base', safeRef(base, 'base'), '--compare', safeRef(compare, 'compare')],
      { cwd: this.root, dvPath: this.dvPath, timeoutMs: 120_000 },
    );
    return r.stdout;
  }

  async discardPath(path: string): Promise<void> {
    // `-f` skips the interactive confirmation dv otherwise waits on. Without
    // it `dv reset <path>` blocks indefinitely when run without a TTY (which
    // is exactly how we run it from the extension), making the command a
    // silent no-op.
    await runDvOrThrow(['reset', safeRepoPath(this.root, path), '-f'], { cwd: this.root, dvPath: this.dvPath });
  }

  async discardAll(includeNew: boolean): Promise<void> {
    const args = ['reset', '--all', '-f', ...(includeNew ? ['--clean'] : [])];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath });
  }

  async listBranches(): Promise<BranchInfo[]> {
    return this.core.listBranches(this.identity.repoId);
  }

  async createBranch(name: string, switchTo = true): Promise<void> {
    const args = ['branch', '-c', safeRef(name, 'branch'), ...(switchTo ? [] : ['--no-checkout'])];
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /**
   * Switch the workspace to a branch / commit / tag.
   *
   * One of the change-handling flags is always sent by our callers, but the
   * *shelf* question is separate: when the target branch has previously-shelved
   * changes, `dv checkout` prompts unless told otherwise. We default to
   * `--ignore-shelf` because a prompt we cannot answer hangs the call (see the
   * stdin note in cli.ts). Ignoring is non-destructive — the shelf survives and
   * stays visible in the Shelves view — so callers opt *in* to applying it.
   */
  async checkout(ref: string, opts: {
    takeChanges?: boolean;
    shelveChanges?: boolean;
    discardChanges?: boolean;
    applyShelf?: boolean;
  } = {}): Promise<void> {
    const flags: string[] = [];
    if (opts.takeChanges) flags.push('--take-changes');
    if (opts.shelveChanges) flags.push('--shelve-changes');
    if (opts.discardChanges) flags.push('--discard-changes');
    flags.push(opts.applyShelf ? '--apply-shelf' : '--ignore-shelf');
    await runDvOrThrow(['checkout', safeRef(ref), ...flags], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /**
   * Merge `ref` into the current branch.
   *
   * `conflictResolution` mirrors dv's `--conflict_resolution`. Note the enum
   * differs from `revert` / `update`: merge takes `keep-destination` where
   * those take `keep-current`. Left unset, dv parks a conflicting merge
   * server-side for per-block resolution in the Diversion app — call
   * {@link listOpenMerges} afterwards to find out whether that happened,
   * because `dv merge` exits 0 either way.
   */
  async merge(
    ref: string,
    conflictResolution?: 'manual' | 'keep-destination' | 'accept-incoming',
  ): Promise<void> {
    const args = ['merge', safeRef(ref)];
    if (conflictResolution) args.push('--conflict_resolution', conflictResolution);
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /**
   * Merges parked on unresolved conflicts. Sourced from the CoreAPI rather
   * than `dv merge -l` because the CLI's listing is unstructured text.
   */
  async listOpenMerges(): Promise<OpenMerge[]> {
    return this.core.listOpenMerges(this.identity.repoId);
  }

  async logOneline(limit = 50): Promise<CommitSummary[]> {
    return this.core.logOneline(this.identity.repoId, limit);
  }

  async logFull(limit = 20): Promise<CommitDetails[]> {
    return this.core.listCommits(this.identity.repoId, { limit });
  }

  /**
   * Extended log accepting an optional path-scope and date filters. Path
   * scope uses the CoreAPI object-history endpoint; date filters (`since` /
   * `until`, ISO or relative like "1 week ago") are resolved client-side
   * and applied to the fetched page. Used by both "history of file X" and
   * "what's been committed lately" flows.
   */
  async logFiltered(opts: {
    path?: string;
    limit?: number;
    since?: string;
    until?: string;
  } = {}): Promise<CommitDetails[]> {
    const limit = opts.limit ?? 20;
    const commits = opts.path
      ? await this.core.fileHistory(this.identity.repoId, this.identity.commitId, opts.path, limit)
      : await this.core.listCommits(this.identity.repoId, { limit });
    const sinceMs = resolveDateBound(opts.since);
    const untilMs = resolveDateBound(opts.until);
    if (sinceMs === undefined && untilMs === undefined) return commits;
    return commits.filter((c) => {
      const t = Date.parse(c.date);
      if (Number.isNaN(t)) return true; // don't drop commits we can't date
      if (sinceMs !== undefined && t < sinceMs) return false;
      if (untilMs !== undefined && t > untilMs) return false;
      return true;
    });
  }

  /**
   * Identify recent commits that touch the same paths the user has
   * uncommitted changes in — the "what might conflict with my working
   * tree" awareness signal. Diversion has no native equivalent of git's
   * `--name-only --intersect` so we do it ourselves: fetch the last
   * `lookback` commits, then ask `dv show --name-status` for each and
   * intersect their changed paths with our dirty set.
   *
   * Cost is O(lookback) CoreAPI requests — bounded by the caller. The
   * CoreAPI client's own request semaphore caps real concurrency (this path
   * is HTTP, not the dv CLI, so cli.ts's process semaphore does not apply),
   * so a large `lookback` can't open hundreds of sockets at once.
   */
  async overlappingCommits(opts: {
    lookback?: number;
    since?: string;
  } = {}): Promise<Array<{ commit: CommitDetails; touched: string[] }>> {
    const state = await this.getState();
    const dirty = new Set(state.changes.map((c) => c.path));
    if (dirty.size === 0) return [];

    const commits = await this.logFiltered({
      limit: opts.lookback ?? 50,
      ...(opts.since ? { since: opts.since } : {}),
    });

    const results = await Promise.all(commits.map(async (c) => {
      const changes = await this.fileChangesForCommit(c.id).catch(() => []);
      const touched = changes.map((f) => f.path).filter((p) => dirty.has(p));
      return { commit: c, touched };
    }));
    return results.filter((r) => r.touched.length > 0);
  }

  /** Per-file history via the CoreAPI object-history endpoint. */
  async fileHistory(relPath: string, limit = 20): Promise<CommitDetails[]> {
    return this.core.fileHistory(this.identity.repoId, this.identity.commitId, relPath, limit);
  }

  /** List all tags in the repo. dv supports `--json` here, so we parse cleanly. */
  async listTags(): Promise<TagInfo[]> {
    const r = await runDvOrThrow(['tag', '--json'], { cwd: this.root, dvPath: this.dvPath });
    return parseTagList(r.stdout);
  }

  /** Delete a branch. The default branch cannot be deleted. */
  async deleteBranch(branch: string): Promise<void> {
    await runDvOrThrow(['branch', '-d', safeRef(branch, 'branch'), '-f'], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
  }

  /** Rename a branch. */
  async renameBranch(branch: string, newName: string): Promise<void> {
    await runDvOrThrow(['branch', '-r', safeRef(branch, 'branch'), safeRef(newName, 'branch')], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
  }

  /**
   * List repos visible to the authenticated user — locally-cloned and
   * remote. Sourced from the CoreAPI; local clone paths are filled in from
   * the agent's workspace registry.
   */
  async listCloudRepos(): Promise<RepoListEntry[]> {
    return this.core.listRepos();
  }

  /** Show the contents of a single shelf (raw dv text — format is human-formatted). */
  async showShelf(shelf: string): Promise<string> {
    const r = await runDvOrThrow(['shelf', 'show', safeRef(shelf, 'shelf')], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
    return r.stdout;
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
  async annotate(relPath: string, token?: CancellationLike): Promise<Annotation[]> {
    const r = await runDvOrThrow(['annotate', safeRepoPath(this.root, relPath)], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000, token,
    });
    return parseAnnotation(r.stdout);
  }

  /**
   * File changes introduced by a single commit — the diff against its first
   * parent (or the empty tree for a root commit), via the CoreAPI compare
   * endpoint.
   */
  async fileChangesForCommit(commitId: string): Promise<FileChange[]> {
    return this.core.commitChanges(this.identity.repoId, commitId);
  }

  /** Cherry-pick a commit's changes into the current workspace. */
  async cherryPick(commitId: string): Promise<void> {
    await runDvOrThrow(['cherry-pick', safeRef(commitId, 'commit')], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /** Revert the changes of a past commit (creates a new commit that inverts it). */
  async revertCommit(commitId: string, conflictResolution?: 'manual' | 'keep-current' | 'accept-incoming'): Promise<void> {
    const args = ['revert', safeRef(commitId, 'commit')];
    if (conflictResolution) args.push('--conflict_resolution', conflictResolution);
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  /** Set the workspace contents to match the given commit (does not rewrite history). */
  async revertToCommit(commitId: string): Promise<void> {
    await runDvOrThrow(['revert-to-commit', safeRef(commitId, 'commit')], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /** Restore a single file from a ref into the workspace. */
  async restorePath(ref: string, relPath: string): Promise<void> {
    await runDvOrThrow(['restore', safeRepoPath(this.root, relPath), '--source', safeRef(ref)], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 0,
    });
  }

  /**
   * Create a tag at a specific commit (or the current commit if `commitId`
   * is omitted). dv accepts an optional description via `-a`.
   */
  async createTag(name: string, commitId?: string, description?: string): Promise<void> {
    const args = ['tag', '-c', safeRef(name, 'tag')];
    if (description) args.push('-a', description);
    if (commitId) args.push('--ref', safeRef(commitId, 'commit'));
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
  }

  /**
   * Fetch full details for a single commit. Returns undefined if dv has
   * no record of the ID (e.g. malformed input). Used by clipboard/share
   * actions that need the message body.
   */
  async showCommit(commitId: string): Promise<CommitDetails | undefined> {
    return this.core.getCommit(this.identity.repoId, commitId);
  }

  // ───── shelves ─────

  async listShelves(): Promise<ShelfInfo[]> {
    return this.core.listShelves(this.identity.repoId);
  }

  /**
   * Create a shelf from the current workspace changes.
   * @param paths   workspace-relative paths to shelve. Empty/undefined = all changes.
   * @param keepWorkingChanges  if true, pass --no-reset to keep working tree intact.
   */
  async createShelf(name: string, paths?: readonly string[], keepWorkingChanges = false): Promise<void> {
    const args = ['shelf', 'create', safeRef(name, 'shelf')];
    if (paths && paths.length > 0) args.push(...paths.map((p) => safeRepoPath(this.root, p)));
    if (keepWorkingChanges) args.push('--no-reset');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async applyShelf(shelf: string, keepShelfAfter = false): Promise<void> {
    const args = ['shelf', 'apply', safeRef(shelf, 'shelf'), '-f'];
    if (keepShelfAfter) args.push('--keep');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 0 });
  }

  async deleteShelf(shelf: string): Promise<void> {
    await runDvOrThrow(['shelf', 'delete', safeRef(shelf, 'shelf'), '-f'], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
  }

  async renameShelf(shelf: string, newName: string): Promise<void> {
    await runDvOrThrow(['shelf', 'rename', safeRef(shelf, 'shelf'), safeRef(newName, 'shelf')], {
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
    await runDvOrThrow(['lock', safeRepoPath(this.root, relPath)], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
    this.locksCache = undefined;
  }

  /** Release a lock on the given path. */
  async unlockPath(relPath: string): Promise<void> {
    await runDvOrThrow(['lock', '-d', safeRepoPath(this.root, relPath)], { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
    this.locksCache = undefined;
  }

  /** Drop the lock cache (call after potentially state-changing operations). */
  invalidateLockCache(): void {
    this.locksCache = undefined;
  }

  /**
   * Sync-conflict sidecars, cached. `findSyncConflicts` walks the entire
   * workspace tree, which is far too expensive to repeat on every refresh
   * (save / focus / watcher batch) on a large repo. Conflicts are represented
   * by on-disk `*.dv-conflict` files, so the FS watcher is the authoritative
   * signal for their appearance/disappearance — it calls
   * {@link invalidateConflictCache} on matching events. Between those events
   * the set is stable and we serve it from cache.
   */
  private async ensureConflicts(): Promise<SyncConflict[]> {
    if (this.conflictCache) return this.conflictCache;
    this.conflictCache = await findSyncConflicts(this.root);
    return this.conflictCache;
  }

  /** Drop the cached conflict set; the next {@link getState} re-walks. */
  invalidateConflictCache(): void {
    this.conflictCache = undefined;
  }

  private locksCache: LockInfo[] | undefined;
  private locksCacheAt = 0;
  private conflictCache: SyncConflict[] | undefined;
}

export async function deleteSidecar(sidecarPath: string): Promise<void> {
  await fs.unlink(sidecarPath);
}

/**
 * Run `fn` over `items` with at most `limit` in flight. A tiny worker-pool —
 * used to batch filesystem stats that would otherwise run strictly serially.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

const RELATIVE_RE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30d
  year: 31_536_000_000, // 365d
};

/**
 * Resolve a `since`/`until` value to an epoch-ms bound. Accepts ISO dates
 * and relative expressions like "1 week ago" / "3 days ago" (the forms the
 * MCP/AI tool descriptions advertise). Returns undefined for empty or
 * unparseable input so the caller skips filtering rather than dropping all
 * commits.
 */
function resolveDateBound(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const unit = UNIT_MS[rel[2]!.toLowerCase()];
    if (unit) return Date.now() - n * unit;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? undefined : ms;
}

function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}
