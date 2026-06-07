import { randomUUID } from 'node:crypto';
import type { DaemonClient } from './daemon.js';
import type { LoggerLike } from '../util/logCore.js';

/** Build-time stamped by esbuild (see esbuild.config.mjs); falls back under tsc/vitest. */
declare const __APP_VERSION__: string;
const APP_NAME = '@mtuska/vscode-diversion';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
import type {
  BranchInfo,
  CommitDetails,
  CommitSummary,
  CoreBranch,
  CoreCommit,
  CoreComparisonItem,
  CoreComparisonResponse,
  CoreListEnvelope,
  CoreOtherStatusesResponse,
  CoreRepo,
  CoreShelf,
  CoreToken,
  FileChange,
  RepoListEntry,
  ShelfInfo,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.diversion.dev/v0';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh the cached token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

export interface CoreApiClientOptions {
  /** Override the CoreAPI base URL (defaults to the production endpoint). */
  baseUrl?: string;
  timeoutMs?: number;
}

export class CoreApiError extends Error {
  /**
   * True for transient connection failures (stale socket, reset, DNS blip)
   * where a retry is safe. False for HTTP error responses (the server
   * answered) and timeouts (retrying just burns the deadline again).
   */
  constructor(message: string, readonly status?: number, readonly retriable = false) {
    super(message);
    this.name = 'CoreApiError';
  }
}

/**
 * Typed client for the Diversion cloud CoreAPI. Auth is delegated to the
 * local sync agent: we fetch a short-lived bearer via `daemon.coreToken()`
 * and cache it in memory until just before it expires.
 *
 * This replaces text-parsing the `dv` CLI for read operations (status,
 * branches, log, compare, shelves, repos). The token is a write-capable
 * credential — it is never logged or persisted.
 */
export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: CoreToken | undefined;

  constructor(
    private readonly daemon: DaemonClient,
    private readonly logger: LoggerLike,
    opts: CoreApiClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ───── compare ─────

  /**
   * Files changed by comparing two refs (commit / branch / workspace / tag).
   * With `base = commit's parent` this yields the changes introduced by a
   * single commit — the replacement for `dv show --name-status`.
   */
  async compare(repoId: string, baseId: string, otherId: string): Promise<FileChange[]> {
    const res = await this.get<CoreComparisonResponse>(
      `/repos/${enc(repoId)}/compare?base_id=${enc(baseId)}&other_id=${enc(otherId)}`,
    );
    return (res.items ?? []).map(mapComparisonItem).filter((c): c is FileChange => c !== undefined);
  }

  // ───── branches ─────

  async listBranches(repoId: string): Promise<BranchInfo[]> {
    const items = await this.listAll<CoreBranch>(`/repos/${enc(repoId)}/branches`);
    return items
      .filter((b) => !b.is_deleted)
      .map((b) => ({ name: b.branch_name, id: b.branch_id, commitId: b.commit_id }));
  }

  // ───── commits / log ─────

  /**
   * List commits, newest first. `refIds` scopes to specific branches/refs
   * (defaults to all). The CoreAPI caps a page at `limit`; we page through
   * with `skip` until we have `limit` items or the repo runs out.
   */
  async listCommits(
    repoId: string,
    opts: { limit?: number; refIds?: readonly string[] } = {},
  ): Promise<CommitDetails[]> {
    const limit = opts.limit ?? 20;
    const out: CoreCommit[] = [];
    let skip = 0;
    while (out.length < limit) {
      const page = Math.min(100, limit - out.length);
      const qs = new URLSearchParams({ limit: String(page), skip: String(skip) });
      for (const ref of opts.refIds ?? []) qs.append('ref_ids', ref);
      const res = await this.get<CoreListEnvelope<CoreCommit>>(
        `/repos/${enc(repoId)}/commits?${qs.toString()}`,
      );
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < page) break; // ran out
      skip += items.length;
    }
    return out.slice(0, limit).map(mapCommit);
  }

  async logOneline(repoId: string, limit = 50): Promise<CommitSummary[]> {
    const commits = await this.listCommits(repoId, { limit });
    return commits.map((c) => ({ id: c.id, subject: firstLine(c.message) }));
  }

  /**
   * Per-file history. CoreAPI exposes `compare` and `commits`; for a path
   * we list commits scoped to the workspace then filter to those touching
   * the path is too costly, so we use the dedicated object-history endpoint.
   */
  async fileHistory(repoId: string, refId: string, relPath: string, limit = 20): Promise<CommitDetails[]> {
    const res = await this.get<CoreListEnvelope<CoreCommit>>(
      `/repos/${enc(repoId)}/files/history/${enc(refId)}/${encodePath(relPath)}?limit=${limit}`,
    );
    return (res.items ?? []).slice(0, limit).map(mapCommit);
  }

  async getCommit(repoId: string, commitId: string): Promise<CommitDetails | undefined> {
    const raw = await this.getCommitRaw(repoId, commitId);
    return raw ? mapCommit(raw) : undefined;
  }

  private async getCommitRaw(repoId: string, commitId: string): Promise<CoreCommit | undefined> {
    const res = await this.get<CoreListEnvelope<CoreCommit>>(
      `/repos/${enc(repoId)}/commits?${new URLSearchParams({ ref_ids: commitId, limit: '1' }).toString()}`,
    );
    return (res.items ?? []).find((c) => c.commit_id === commitId) ?? (res.items ?? [])[0];
  }

  /**
   * Changes introduced by a single commit: compare its first parent against
   * the commit itself. A root commit (no parents) compares against the empty
   * tree, yielding every file as added. Replaces `dv show --name-status`.
   */
  async commitChanges(repoId: string, commitId: string): Promise<FileChange[]> {
    const raw = await this.getCommitRaw(repoId, commitId);
    const base = raw?.parents?.[0] ?? '';
    return this.compare(repoId, base, commitId);
  }

  // ───── shelves ─────

  async listShelves(repoId: string): Promise<ShelfInfo[]> {
    const items = await this.listAll<CoreShelf>(`/repos/${enc(repoId)}/shelves`);
    return items.map((s) => {
      const date = Number.isFinite(s.created_timestamp)
        ? new Date(s.created_timestamp * 1000).toISOString().slice(0, 10)
        : undefined;
      return {
        id: s.id,
        name: s.name,
        description: [date, s.branch_id].filter(Boolean).join(' · ') || undefined,
        raw: s.name,
      } satisfies ShelfInfo;
    });
  }

  // ───── repos ─────

  /**
   * All repos the user can access. Local clone paths are cross-referenced
   * from the agent's workspace registry so the `cloned` / `localPath`
   * fields match what `dv repo` used to report.
   */
  async listRepos(): Promise<RepoListEntry[]> {
    const [res, localByRepo] = await Promise.all([
      this.get<CoreListEnvelope<CoreRepo>>('/repos'),
      this.localCloneMap(),
    ]);
    return (res.items ?? []).map((r) => {
      const localPath = localByRepo.get(r.repo_id);
      return {
        name: r.repo_name,
        id: r.repo_id,
        cloned: localPath !== undefined,
        ...(localPath ? { localPath } : {}),
      } satisfies RepoListEntry;
    });
  }

  // ───── awareness ─────

  /** Files being touched in other users' workspaces/branches (clash signal). */
  async otherStatuses(repoId: string, workspaceId: string): Promise<CoreOtherStatusesResponse> {
    return this.get<CoreOtherStatusesResponse>(
      `/repos/${enc(repoId)}/workspaces/${enc(workspaceId)}/other_statuses`,
    );
  }

  // ───── internals ─────

  /**
   * Fetch every item from a `{ items[] }` list endpoint, paging with
   * `limit`/`skip` until a short page comes back. Used for unbounded lists
   * (branches, shelves) so large repos aren't truncated at the first page.
   */
  private async listAll<T>(pathBase: string): Promise<T[]> {
    const PAGE = 100;
    const HARD_CAP = 10_000; // safety valve against an endlessly-paging server
    const sep = pathBase.includes('?') ? '&' : '?';
    const out: T[] = [];
    let skip = 0;
    for (;;) {
      const res = await this.get<CoreListEnvelope<T>>(`${pathBase}${sep}limit=${PAGE}&skip=${skip}`);
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < PAGE || out.length >= HARD_CAP) break;
      skip += items.length;
    }
    return out;
  }

  private async localCloneMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const all = await this.daemon.workspaces();
      for (const ws of Object.values(all)) {
        if (ws.RepoID && ws.Path) map.set(ws.RepoID, ws.Path);
      }
    } catch (err) {
      this.logger.debug(`localCloneMap: daemon unavailable: ${(err as Error).message}`);
    }
    return map;
  }

  private async bearer(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.ExpiresAt * 1000 - TOKEN_SKEW_MS > now) {
      return this.token.AccessToken;
    }
    this.token = await this.daemon.coreToken();
    return this.token.AccessToken;
  }

  /**
   * GET with one retry on a transient connection failure. Every CoreAPI call
   * here is an idempotent read, so a single immediate retry is safe and keeps
   * the refresh cadence smooth across a dropped pooled socket. We do NOT retry
   * HTTP error responses (the server answered) or timeouts (a retry just burns
   * the deadline again).
   */
  private async get<T>(pathname: string): Promise<T> {
    try {
      return await this.attempt<T>(pathname);
    } catch (err) {
      if (err instanceof CoreApiError && err.retriable) {
        this.logger.debug(`CoreAPI retry after transient error: ${err.message}`);
        await delay(100);
        return this.attempt<T>(pathname);
      }
      throw err;
    }
  }

  private async attempt<T>(pathname: string): Promise<T> {
    const token = await this.bearer();
    const url = this.baseUrl + pathname;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-DV-App-Name': APP_NAME,
          'X-DV-App-Version': APP_VERSION,
          'X-Sentry-Correlation-ID': randomUUID(),
        },
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Token may have just expired — drop it so the next call re-mints.
        this.token = undefined;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new CoreApiError(`${pathname} → HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CoreApiError) throw err;
      // AbortError = our timeout fired; anything else = a connection-level
      // failure (reset, DNS, refused) that's worth one retry.
      const timedOut = (err as Error)?.name === 'AbortError';
      const msg = timedOut
        ? `CoreAPI request to ${pathname} timed out after ${this.timeoutMs}ms`
        : `CoreAPI request to ${pathname} failed: ${(err as Error).message}`;
      throw new CoreApiError(msg, undefined, /* retriable */ !timedOut);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───── mappers ─────

function mapComparisonItem(item: CoreComparisonItem): FileChange | undefined {
  const { base_item: base, other_item: other } = item;
  if (!base && other) return { kind: 'added', path: other.path };
  if (base && !other) return { kind: 'deleted', path: base.path };
  if (base && other) {
    if (other.prev_path && other.prev_path !== other.path) {
      return { kind: 'renamed', path: other.path, fromPath: other.prev_path };
    }
    return { kind: 'modified', path: other.path };
  }
  return undefined;
}

function mapCommit(c: CoreCommit): CommitDetails {
  const parents = c.parents ?? [];
  const details: CommitDetails = {
    id: c.commit_id,
    refs: (c.parent_branches ?? []).map((b) => b.name).filter(Boolean),
    authorName: c.author?.full_name || c.author?.name || '',
    authorEmail: c.author?.email ?? '',
    date: Number.isFinite(c.created_ts) ? new Date(c.created_ts * 1000).toISOString() : '',
    message: c.commit_message ?? '',
  };
  if (parents.length > 1) {
    details.merge = { refName: c.parent_branches?.[1]?.name ?? '', commitId: parents[1]! };
  }
  return details;
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Encode a repo-relative path for a URL while keeping `/` separators. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
