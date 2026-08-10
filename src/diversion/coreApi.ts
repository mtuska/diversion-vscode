import { randomUUID } from 'node:crypto';
import { Semaphore } from '../util/semaphore.js';
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
  CoreDetailedMerge,
  CoreListEnvelope,
  CoreMerge,
  CoreOtherStatusesResponse,
  CoreRepo,
  CoreShelf,
  CoreToken,
  DetailedOpenMerge,
  FileChange,
  MergeConflict,
  OpenMerge,
  RepoListEntry,
  ShelfInfo,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.diversion.dev/v0';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh the cached token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;
/**
 * Max concurrent CoreAPI requests per client. Callers like
 * `overlappingCommits` fan out one request per commit; without a cap a single
 * call could open ~1000 sockets at once. This is separate from the dv-process
 * semaphore in cli.ts (which does not govern HTTP).
 */
const CORE_CONCURRENCY = 6;
/** Bounded caches for immutable-by-id reads (commit-by-id, compare-by-pair). */
const COMMIT_CACHE_CAP = 512;
const COMPARE_CACHE_CAP = 256;

/**
 * Insertion-ordered cache with a hard cap. `get` refreshes recency (LRU); on
 * overflow the oldest entry is evicted. Stores promises so identical in-flight
 * requests coalesce into one network call.
 */
class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string): void { this.map.delete(key); }
}

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
/**
 * Validate the configured CoreAPI base URL before we ever attach a
 * write-capable bearer token to a request. A hijacked `diversion.coreApiUrl`
 * (or `DIVERSION_CORE_API_URL`) pointing at an attacker host would otherwise
 * exfiltrate the token on the first call. We fail *safe*: on a cleartext
 * remote URL or an unparseable value we log and fall back to production
 * rather than honoring the dangerous override. Plain `http://` is permitted
 * only for loopback (local test daemons). The effective URL is logged so an
 * unexpected override is visible in the output channel.
 */
export function sanitizeBaseUrl(configured: string | undefined, logger: LoggerLike): string {
  const raw = (configured?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    logger.warn(`CoreAPI: ignoring unparseable coreApiUrl "${raw}", using ${DEFAULT_BASE_URL}`);
    return DEFAULT_BASE_URL;
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    logger.warn(
      `CoreAPI: refusing cleartext/non-https endpoint "${raw}" for a bearer token; ` +
      `using ${DEFAULT_BASE_URL}`,
    );
    return DEFAULT_BASE_URL;
  }
  if (raw !== DEFAULT_BASE_URL) logger.info(`CoreAPI base URL overridden: ${raw}`);
  return raw;
}

export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: CoreToken | undefined;
  private tokenInFlight: Promise<CoreToken> | undefined;
  private readonly limiter = new Semaphore(CORE_CONCURRENCY);
  private readonly commitCache = new BoundedCache<Promise<CoreCommit | undefined>>(COMMIT_CACHE_CAP);
  private readonly compareCache = new BoundedCache<Promise<FileChange[]>>(COMPARE_CACHE_CAP);

  constructor(
    private readonly daemon: DaemonClient,
    private readonly logger: LoggerLike,
    opts: CoreApiClientOptions = {},
  ) {
    this.baseUrl = sanitizeBaseUrl(opts.baseUrl, logger);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ───── compare ─────

  /**
   * Files changed by comparing two refs (commit / branch / workspace / tag).
   * With `base = commit's parent` this yields the changes introduced by a
   * single commit — the replacement for `dv show --name-status`.
   */
  async compare(repoId: string, baseId: string, otherId: string): Promise<FileChange[]> {
    // A comparison between two fixed commit IDs is immutable — cache it (and
    // coalesce identical in-flight requests). Skip the cache when either side
    // is a mutable ref (empty = empty tree, or a branch/workspace name).
    const key = `${repoId}\t${baseId}\t${otherId}`;
    const cacheable = isCommitId(baseId) || baseId === '';
    if (cacheable && isCommitId(otherId)) {
      return this.cached(this.compareCache, key, () => this.compareUncached(repoId, baseId, otherId));
    }
    return this.compareUncached(repoId, baseId, otherId);
  }

  private async compareUncached(repoId: string, baseId: string, otherId: string): Promise<FileChange[]> {
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
   * Per-file history, via the dedicated object-history endpoint (listing all
   * commits and filtering to those touching the path is far too costly).
   *
   * Pages with `limit`/`skip` like the other list readers. It previously
   * issued a single request with the caller's full limit, so a caller asking
   * for more than one page's worth — the MCP tool advertises up to 1000 —
   * silently got one page back with no truncation signal.
   */
  async fileHistory(repoId: string, refId: string, relPath: string, limit = 20): Promise<CommitDetails[]> {
    const base = `/repos/${enc(repoId)}/files/history/${enc(refId)}/${encodePath(relPath)}`;
    const out: CoreCommit[] = [];
    let skip = 0;
    while (out.length < limit) {
      const page = Math.min(100, limit - out.length);
      const res = await this.get<CoreListEnvelope<CoreCommit>>(
        `${base}?${new URLSearchParams({ limit: String(page), skip: String(skip) }).toString()}`,
      );
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < page) break; // ran out of history
      skip += items.length;
    }
    return out.slice(0, limit).map(mapCommit);
  }

  async getCommit(repoId: string, commitId: string): Promise<CommitDetails | undefined> {
    const raw = await this.getCommitRaw(repoId, commitId);
    return raw ? mapCommit(raw) : undefined;
  }

  private getCommitRaw(repoId: string, commitId: string): Promise<CoreCommit | undefined> {
    // A commit fetched by its own ID is immutable — cache + coalesce so the
    // getCommit/commitChanges pair and repeated graph clicks don't re-fetch.
    if (!isCommitId(commitId)) return this.getCommitRawUncached(repoId, commitId);
    return this.cached(this.commitCache, `${repoId}\t${commitId}`,
      () => this.getCommitRawUncached(repoId, commitId));
  }

  private async getCommitRawUncached(repoId: string, commitId: string): Promise<CoreCommit | undefined> {
    const res = await this.get<CoreListEnvelope<CoreCommit>>(
      `/repos/${enc(repoId)}/commits?${new URLSearchParams({ ref_ids: commitId, limit: '1' }).toString()}`,
    );
    return (res.items ?? []).find((c) => c.commit_id === commitId) ?? (res.items ?? [])[0];
  }

  /** Coalesce identical in-flight requests and cache immutable results. */
  private cached<T>(cache: BoundedCache<Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing;
    const p = fn().catch((err) => { cache.delete(key); throw err; });
    cache.set(key, p);
    return p;
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

  // ───── merges ─────

  /**
   * Merges that stopped on conflicts and are waiting for a human. `dv merge`
   * returns as soon as the backend parks one of these, so this is the only way
   * to tell "merged cleanly" from "merged into a pile of conflicts".
   *
   * Not paged: the endpoint returns every open merge in the repo, and a repo
   * with enough unresolved merges to need paging has a bigger problem.
   */
  async listOpenMerges(repoId: string): Promise<OpenMerge[]> {
    const res = await this.get<CoreListEnvelope<CoreMerge>>(`/repos/${enc(repoId)}/merges`);
    return (res.items ?? []).map((m) => {
      const merge: OpenMerge = { id: m.id, baseRef: m.base_ref, otherRef: m.other_ref };
      const who = m.user?.full_name || m.user?.name;
      if (who) merge.startedBy = who;
      return merge;
    });
  }

  /** One open merge with its per-path conflicts. */
  async getMerge(repoId: string, mergeId: string): Promise<DetailedOpenMerge> {
    const m = await this.get<CoreDetailedMerge>(`/repos/${enc(repoId)}/merges/${enc(mergeId)}`);
    const merge: DetailedOpenMerge = {
      id: m.id,
      baseRef: m.base_ref,
      otherRef: m.other_ref,
      conflicts: (m.conflicts ?? []).map((c) => {
        const conflict: MergeConflict = {
          id: c.conflict_id,
          resolved: Boolean(c.is_resolved),
          path: c.other?.path || c.base?.path || '(unknown)',
          basePath: c.base?.path ?? '',
          otherPath: c.other?.path ?? '',
          // Mode is a required query param when submitting; prefer the
          // incoming side's, which is what a "keep incoming" result carries.
          fileMode: c.other?.file_mode ?? c.base?.file_mode ?? 0o100644,
        };
        if (c.resolved_side) conflict.resolvedSide = c.resolved_side;
        return conflict;
      }),
    };
    const who = m.user?.full_name || m.user?.name;
    if (who) merge.startedBy = who;
    return merge;
  }

  /**
   * Raw file content at a ref. The endpoint answers either 200 with the bytes
   * inline or 204 with a `Location` pointing at presigned object storage.
   *
   * We follow the redirect but never attach the bearer to it — the URL is
   * already presigned, and the token is write-capable, so handing it to
   * whatever host `Location` names is not a risk worth taking. If Diversion
   * ever redirects somewhere that *does* need auth we'll see a 401 here
   * rather than having quietly leaked the credential.
   */
  async blobText(repoId: string, refId: string, relPath: string): Promise<string> {
    const pathname = `/repos/${enc(repoId)}/blobs/${enc(refId)}/${encodePath(relPath)}`;
    const res = await this.rawRequest(pathname, { accept: 'application/octet-stream' });
    if (res.status === 204) {
      const location = res.headers.get('location');
      if (!location) throw new CoreApiError(`${pathname} → 204 with no Location header`, 204);
      const follow = await fetch(location, { headers: { Accept: 'application/octet-stream' } });
      if (!follow.ok) {
        throw new CoreApiError(`blob redirect → HTTP ${follow.status}`, follow.status);
      }
      return follow.text();
    }
    return res.text();
  }

  /**
   * Submit the resolved content for one conflicting path.
   *
   * Only `mode` is required; `storage_backend` / `storage_uri` exist for the
   * async upload flow and `sha1` with it, so an inline resolution is just the
   * bytes plus the mode we read off the conflict.
   */
  async setConflictResult(
    repoId: string,
    mergeId: string,
    conflictId: string,
    content: string,
    fileMode: number,
  ): Promise<void> {
    const body = Buffer.from(content, 'utf8');
    const qs = new URLSearchParams({ mode: String(fileMode), size: String(body.byteLength) });
    await this.rawRequest(
      `/repos/${enc(repoId)}/merges/${enc(mergeId)}/conflicts/${enc(conflictId)}?${qs.toString()}`,
      { method: 'POST', body, contentType: 'application/octet-stream' },
    );
  }

  /** Commit the merge once every conflict is resolved. */
  async finalizeMerge(repoId: string, mergeId: string, commitMessage: string): Promise<void> {
    await this.rawRequest(`/repos/${enc(repoId)}/merges/${enc(mergeId)}`, {
      method: 'POST',
      body: JSON.stringify({ commit_message: commitMessage }),
      contentType: 'application/json',
    });
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
    // Single-flight: N concurrent requests at expiry share one mint instead
    // of stampeding the local agent.
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.daemon.coreToken().finally(() => { this.tokenInFlight = undefined; });
    }
    this.token = await this.tokenInFlight;
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

  /**
   * A single request returning the raw `Response`, for the endpoints that
   * aren't JSON-in / JSON-out: blob downloads (which may 204-redirect) and
   * the merge-resolution writes (octet-stream up, empty down).
   *
   * Deliberately not retried. `get` retries transient connection failures
   * because every call behind it is an idempotent read; a POST that resolves
   * a conflict or finalizes a merge is not safe to replay blindly.
   */
  private rawRequest(
    pathname: string,
    opts: { method?: string; body?: string | Uint8Array; contentType?: string; accept?: string } = {},
  ): Promise<Response> {
    return this.limiter.run(async () => {
      const token = await this.bearer();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: opts.accept ?? 'application/json',
          'X-DV-App-Name': APP_NAME,
          'X-DV-App-Version': APP_VERSION,
          'X-Sentry-Correlation-ID': randomUUID(),
        };
        if (opts.contentType) headers['Content-Type'] = opts.contentType;
        const res = await fetch(this.baseUrl + pathname, {
          method: opts.method ?? 'GET',
          headers,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          signal: ctrl.signal,
          // 204+Location is a documented response here, not an HTTP redirect
          // to follow blindly — we decide per-host whether to send the token.
          redirect: 'manual',
        });
        if (res.status === 401 || res.status === 403) this.token = undefined;
        if (!res.ok && res.status !== 204) {
          const detail = await res.text().catch(() => '');
          throw new CoreApiError(`${pathname} → HTTP ${res.status}: ${detail.slice(0, 200)}`, res.status);
        }
        return res;
      } catch (err) {
        if (err instanceof CoreApiError) throw err;
        const timedOut = (err as Error)?.name === 'AbortError';
        throw new CoreApiError(
          timedOut
            ? `CoreAPI request to ${pathname} timed out after ${this.timeoutMs}ms`
            : `CoreAPI request to ${pathname} failed: ${(err as Error).message}`,
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private attempt<T>(pathname: string): Promise<T> {
    // Bound concurrent requests so a fan-out (e.g. overlappingCommits) can't
    // open hundreds of sockets at once.
    return this.limiter.run(() => this.attemptOnce<T>(pathname));
  }

  private async attemptOnce<T>(pathname: string): Promise<T> {
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

/**
 * True for a concrete, immutable Diversion commit ID (`dv.commit.<n>`). Branch
 * names, workspace refs, and the empty-tree sentinel are mutable / special and
 * must not be cached as if fixed.
 */
function isCommitId(id: string): boolean {
  return /^dv\.commit\./.test(id);
}

/** Encode a repo-relative path for a URL while keeping `/` separators. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
