import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runDv, runDvOrThrow, type CancellationLike } from './cli.js';
import { safeRepoPath, safeRepoPattern, safeRef } from './argGuard.js';
import { listFilesRecursive } from '../util/walk.js';
import { CoreApiClient } from './coreApi.js';
import { parseStatus, type ParsedStatus } from './parsers/status.js';
import { parseDiffNameStatus } from './parsers/diffNameStatus.js';
import { parseLockList, type LockInfo } from './parsers/lock.js';
import { parseAnnotation, type Annotation } from './parsers/annotate.js';
import { parseLogFull } from './parsers/log.js';
import { parseTagList, type TagInfo } from './parsers/tag.js';
import { findSyncConflicts, type SyncConflict } from './conflicts.js';
import type { DaemonClient } from './daemon.js';
import type {
  BranchInfo,
  CommitDetails,
  ClashingEdit,
  CommitSummary,
  DetailedOpenMerge,
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
 * How long a clash snapshot stays fresh. Other people's in-flight work moves
 * on a human timescale, and this is a cloud round-trip driven by explorer
 * decoration requests — a short TTL would turn scrolling into a request storm.
 */
const CLASH_TTL_MS = 60_000;

/**
 * When a `since`/`until` bound is set we filter client-side, so we fetch this
 * multiple of the caller's limit to give the date window room. The absolute
 * cap keeps an open-ended "everything since 2020" from walking a whole repo.
 */
const DATE_OVERFETCH = 10;
const MAX_DATE_SCAN = 1_000;

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
    /**
     * CoreAPI connection overrides. `accessToken` lets an operator bypass the
     * local agent's token minting entirely — see CoreApiClientOptions.
     */
    private readonly coreOptions: { baseUrl?: string; accessToken?: string } = {},
  ) {}

  /** Lazily-constructed CoreAPI client (auth via the local agent token). */
  private get core(): CoreApiClient {
    if (!this.coreClient) {
      this.coreClient = new CoreApiClient(this.daemon, this.logger, {
        ...(this.coreOptions.baseUrl ? { baseUrl: this.coreOptions.baseUrl } : {}),
        ...(this.coreOptions.accessToken ? { accessToken: this.coreOptions.accessToken } : {}),
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
   * Show what merging `ref` would do, **in the browser** — that's all dv
   * offers here. `dv merge-preview` prints nothing but "The preview was
   * opened in your browser", so there is no diff for us to render in-editor.
   * Spawn-and-forget, like `dv view`.
   */
  async mergePreview(ref: string, into?: string): Promise<void> {
    const args = ['merge-preview', safeRef(ref)];
    if (into) args.push('--target', safeRef(into, 'branch'));
    await runDv(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 15_000 });
  }

  /**
   * Open a review request for the current branch. `into` defaults to the
   * repository's default branch on dv's side.
   */
  async createReview(title: string, description?: string, into?: string): Promise<string> {
    const args = ['review', safeRef(title, 'title')];
    if (into) args.push('--into', safeRef(into, 'branch'));
    if (description) args.push('-d', description);
    const r = await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000 });
    return r.stdout.trim();
  }

  /**
   * Merges parked on unresolved conflicts. Sourced from the CoreAPI rather
   * than `dv merge -l` because the CLI's listing is unstructured text.
   */
  async listOpenMerges(): Promise<OpenMerge[]> {
    return this.core.listOpenMerges(this.identity.repoId);
  }

  /** One open merge with its per-path conflicts. */
  async getMerge(mergeId: string): Promise<DetailedOpenMerge> {
    return this.core.getMerge(this.identity.repoId, safeRef(mergeId, 'merge'));
  }

  /** Text of a conflicting path on one side of a merge. */
  async mergeSideContent(ref: string, relPath: string): Promise<string> {
    return this.core.blobText(this.identity.repoId, safeRef(ref), relPath);
  }

  /**
   * Submit resolved content for one conflicting path. This is a CoreAPI
   * *write* — the only one we make. Everything else that mutates goes through
   * the CLI so the local agent stays authoritative about sync state, but dv
   * exposes no per-conflict resolution command, so there is no CLI route.
   */
  async resolveMergeConflict(
    mergeId: string,
    conflictId: string,
    content: string,
    fileMode: number,
  ): Promise<void> {
    await this.core.setConflictResult(
      this.identity.repoId, safeRef(mergeId, 'merge'), conflictId, content, fileMode,
    );
  }

  /**
   * Commit a fully-resolved merge, then wake the agent so the merged result
   * syncs down rather than waiting for the next poll.
   */
  async finalizeMerge(mergeId: string, commitMessage: string): Promise<void> {
    if (commitMessage.length > MAX_COMMIT_MESSAGE_LEN) {
      throw new Error(
        `Commit message is ${commitMessage.length} characters; ` +
        `dv accepts at most ${MAX_COMMIT_MESSAGE_LEN}.`,
      );
    }
    await this.core.finalizeMerge(this.identity.repoId, safeRef(mergeId, 'merge'), commitMessage);
    await this.notifySyncRequired();
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
    /** Include commits squashed away by merges. Requires `path`. */
    showSquashed?: boolean;
  } = {}): Promise<CommitDetails[]> {
    const limit = opts.limit ?? 20;
    const sinceMs = resolveDateBound(opts.since);
    const untilMs = resolveDateBound(opts.until);
    const dated = sinceMs !== undefined || untilMs !== undefined;

    // Date bounds are resolved client-side, so a naive implementation fetches
    // `limit` commits and then filters — turning "commits from the last month,
    // limit 20" into "of the newest 20 commits, those from the last month".
    // That reads as "only 3 commits last month" when there were fifty, which
    // is worse than an error because it looks like an answer. Over-fetch so
    // the window has room, then trim back to what the caller asked for.
    const fetchLimit = dated ? Math.min(MAX_DATE_SCAN, limit * DATE_OVERFETCH) : limit;
    const commits = opts.path
      ? await this.fileHistory(opts.path, fetchLimit, opts.showSquashed ?? false)
      : await this.core.listCommits(this.identity.repoId, { limit: fetchLimit });
    if (!dated) return commits;

    const matching = commits.filter((c) => {
      const t = Date.parse(c.date);
      if (Number.isNaN(t)) return true; // don't drop commits we can't date
      if (sinceMs !== undefined && t < sinceMs) return false;
      if (untilMs !== undefined && t > untilMs) return false;
      return true;
    });
    return matching.slice(0, limit);
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

  /**
   * Per-file history.
   *
   * Normally the CoreAPI object-history endpoint. With `showSquashed` we drop
   * to `dv log --show-squashed`, which also reports the commits a merge
   * squashed away — so a file's history survives merges, with the original
   * author and message intact. The CoreAPI has no equivalent parameter, so
   * this is the one read where the CLI is strictly more capable.
   */
  async fileHistory(relPath: string, limit = 20, showSquashed = false): Promise<CommitDetails[]> {
    if (!showSquashed) {
      return this.core.fileHistory(this.identity.repoId, this.identity.commitId, relPath, limit);
    }
    const r = await runDvOrThrow(
      ['log', '--show-squashed', '--date', 'iso', '-n', String(limit), safeRepoPath(this.root, relPath)],
      { cwd: this.root, dvPath: this.dvPath, timeoutMs: 120_000 },
    );
    return parseLogFull(r.stdout).slice(0, limit);
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
    const changes = await this.core.commitChanges(this.identity.repoId, commitId);
    if (!changes.some((c) => c.isDirectory)) return changes;

    // The compare endpoint collapses an added folder into a single tree entry
    // and does not list what's inside it, so a commit that adds a directory
    // shows up as one un-openable folder row. `dv show --name-status` reports
    // the folder *and* every file under it, which is what we actually want.
    // Only commits that contain a tree entry pay the process spawn.
    try {
      const r = await runDvOrThrow(
        ['show', safeRef(commitId, 'commit'), '--name-status', '--color', 'never'],
        { cwd: this.root, dvPath: this.dvPath, timeoutMs: 120_000 },
      );
      const expanded = dropAncestorDirectories(parseDiffNameStatus(r.stdout));
      if (expanded.length > 0) return sortChanges(expanded);
    } catch (err) {
      this.logger.warn(
        `[repo] could not expand directory entries for ${commitId}: ${(err as Error).message}`,
      );
    }
    return changes;
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
   * Rename a tag and/or replace its description. Keyed on the tag **ID**
   * (`dv.tag.<n>`), not the name — dv's `-m` takes an ID, and names aren't
   * guaranteed stable across a rename race.
   */
  async modifyTag(tagId: string, opts: { name?: string; description?: string } = {}): Promise<void> {
    const args = ['tag', '-m', safeRef(tagId, 'tag')];
    if (opts.name) args.push('--name', safeRef(opts.name, 'tag'));
    if (opts.description !== undefined) args.push('-a', opts.description);
    if (args.length === 3) throw new Error('modifyTag: nothing to change (pass name and/or description).');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
  }

  /** Delete a tag by ID. `-f` skips the confirmation prompt dv would block on. */
  async deleteTag(tagId: string): Promise<void> {
    await runDvOrThrow(['tag', '-d', safeRef(tagId, 'tag'), '-f'], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
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

  // ───── revision retention (dv prune) ─────
  //
  // Retention rules cap how many revisions of a matching file Diversion
  // keeps, pruning older ones — effectively a standing `dv obliterate`, so
  // every write here is irreversible and callers must confirm first.
  //
  // We deliberately do NOT parse `dv prune list` into structured rules. Its
  // table layout is unverified (it needs a Studio/Enterprise repo with rules
  // already configured to observe), and inventing a regex for a format we've
  // never seen is how parsers silently start lying. Callers render the lines
  // as dv printed them; the rule IDs `set`/`remove` need are readable there.

  /** Retention rules, as dv prints them (in priority order, last match wins). */
  async listPruneRules(): Promise<string[]> {
    const r = await runDvOrThrow(['prune', 'list'], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
    return r.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  }

  /**
   * Add a retention rule. `keep` is 1-999 or 'all' (never prune).
   * Irreversible for revisions already beyond the limit — confirm first.
   */
  async addPruneRule(pattern: string, keep: number | 'all'): Promise<void> {
    await runDvOrThrow(['prune', 'add', safeRepoPattern(pattern), '--keep', String(keep)], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000,
    });
  }

  async setPruneRule(id: string, opts: { keep?: number | 'all'; pattern?: string }): Promise<void> {
    const args = ['prune', 'set', safeRef(id, 'rule id')];
    if (opts.keep !== undefined) args.push('--keep', String(opts.keep));
    if (opts.pattern !== undefined) args.push('--pattern', safeRepoPattern(opts.pattern));
    if (args.length === 3) throw new Error('setPruneRule: nothing to change (pass keep and/or pattern).');
    await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 60_000 });
  }

  async removePruneRule(id: string): Promise<void> {
    await runDvOrThrow(['prune', 'remove', safeRef(id, 'rule id')], {
      cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000,
    });
  }

  /** Read the repo-wide retention settings, or set case-sensitivity. */
  async pruneConfig(caseInsensitive?: boolean): Promise<string> {
    const args = ['prune', 'config'];
    if (caseInsensitive !== undefined) args.push('--case-insensitive', caseInsensitive ? 'true' : 'false');
    const r = await runDvOrThrow(args, { cwd: this.root, dvPath: this.dvPath, timeoutMs: 30_000 });
    return r.stdout.trim();
  }

  /**
   * Paths other people are touching right now — advisory, not a lock.
   *
   * Cached for a minute: this is a cloud round-trip driven by decoration
   * requests, and other people's work doesn't change second to second.
   */
  async clashingEdits(): Promise<ClashingEdit[]> {
    if (this.clashCache && Date.now() - this.clashCacheAt < CLASH_TTL_MS) {
      return this.clashCache;
    }
    const clashes = await this.core.clashingEdits(this.identity.repoId, this.identity.workspaceId);
    this.clashCache = clashes;
    this.clashCacheAt = Date.now();
    return clashes;
  }

  /** Drop the clash cache so the next read re-queries. */
  invalidateClashCache(): void {
    this.clashCache = undefined;
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
  private clashCache: ClashingEdit[] | undefined;
  private clashCacheAt = 0;
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

/**
 * Drop entries that are merely an ancestor directory of another entry.
 *
 * `dv show --name-status` lists an added folder alongside each file inside it.
 * The folder row is noise in a file list — and unlike the files, it can't be
 * opened or diffed. A path that is a strict prefix of another entry's path can
 * only be a directory, so no mode information is needed to spot them.
 */
export function dropAncestorDirectories(changes: readonly FileChange[]): FileChange[] {
  const ancestors = new Set<string>();
  for (const c of changes) {
    const p = c.path;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '/' || p[i] === '\\') ancestors.add(p.slice(0, i));
    }
  }
  return changes.filter((c) => !ancestors.has(c.path));
}

function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}
