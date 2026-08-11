import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type {
  CoreToken,
  DaemonHealth,
  DaemonWorkspace,
  DaemonWorkspaces,
  FileSyncStatus,
  WorkspaceSyncProgress,
  WorkspaceSyncStatus,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 3000;

export interface DaemonClientOptions {
  /** Override base URL (e.g. http://127.0.0.1:38825). When set, skips port discovery. */
  baseUrl?: string;
  /** Override path to ~/.diversion. Used in tests. */
  diversionHome?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export class DaemonUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

/**
 * HTTP client for the local Diversion sync agent (the AgentAPI surface).
 * The agent listens on a loopback port published in `~/.diversion/.port`;
 * the endpoints used here are documented in the official AgentAPI OpenAPI
 * spec that ships with Diversion's Unreal plugin, and let us avoid
 * spawning the `dv` CLI for hot-path operations:
 *
 *   - `/health` — liveness probe
 *   - `/workspaces` — full registry (one request, all workspaces)
 *   - `/workspace?abs_path=` — single-workspace lookup by absolute path
 *   - `/repo/{R}/workspace/{W}/sync` GET — sync status (complete/paused)
 *   - `/repo/{R}/workspace/{W}/sync` POST — wake the agent for a re-scan
 *   - `/repo/{R}/workspace/{W}/sync/progress` — bytes/queue/action live state
 *   - `/repo/{R}/workspace/{W}/files/status?Paths=` — per-file sync state
 */
export class DaemonClient {
  private readonly home: string;
  private readonly explicitBaseUrl: string | undefined;
  private readonly timeoutMs: number;
  private cachedBaseUrl: string | undefined;

  constructor(opts: DaemonClientOptions = {}) {
    this.home = opts.diversionHome ?? path.join(os.homedir(), '.diversion');
    this.explicitBaseUrl = opts.baseUrl?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The `.diversion` directory this client is rooted at. Exposed so other
   * components (the credentials reader) resolve against the *same* home
   * rather than re-deriving it and drifting under a custom install.
   */
  get diversionHome(): string { return this.home; }

  async health(): Promise<DaemonHealth> {
    return this.getJson<DaemonHealth>('/health');
  }

  async workspaces(): Promise<DaemonWorkspaces> {
    return this.getJson<DaemonWorkspaces>('/workspaces');
  }

  /**
   * Mint a short-lived CoreAPI access token for the logged-in user. The
   * agent exchanges its stored refresh token and returns a ~1h bearer
   * (`coreapi/read`+`coreapi/write` scope). This lets us call the cloud
   * CoreAPI directly without managing OAuth ourselves.
   *
   * NOTE: `/token/core` is not in the published AgentAPI spec — it's a
   * shipping-but-undocumented endpoint. Callers must degrade gracefully
   * (the agent may gate or remove it in a future release). The returned
   * token is a write-capable credential: keep it in memory only, never
   * log or persist it.
   */
  async coreToken(): Promise<CoreToken> {
    return this.getJson<CoreToken>('/token/core');
  }

  /**
   * Direct lookup of the workspace covering a given absolute path —
   * faster than fetching the full registry and walking it client-side.
   * The agent returns a `{ <workspaceId>: WorkspaceConfiguration }` map,
   * normally a single entry. Returns `undefined` if no workspace
   * matches.
   */
  async workspaceByPath(absPath: string): Promise<DaemonWorkspace | undefined> {
    const url = `/workspace?abs_path=${encodeURIComponent(absPath)}`;
    let map: DaemonWorkspaces;
    try {
      map = await this.getJson<DaemonWorkspaces>(url);
    } catch (err) {
      // The agent answers 4xx for paths it doesn't recognise. We treat
      // that as "no workspace here" rather than propagating an error,
      // since callers are doing exploratory lookups against arbitrary
      // workspace folders.
      if (err instanceof DaemonUnavailableError && /HTTP 4/.test(err.message)) {
        return undefined;
      }
      throw err;
    }
    for (const ws of Object.values(map)) return ws;
    return undefined;
  }

  /**
   * Coarse sync state for a workspace (complete / paused). Use this
   * instead of inferring from `dv status` text — the agent already
   * tracks it natively.
   */
  async syncStatus(repoId: string, workspaceId: string): Promise<WorkspaceSyncStatus> {
    return this.getJson<WorkspaceSyncStatus>(
      `/repo/${encodeURIComponent(repoId)}/workspace/${encodeURIComponent(workspaceId)}/sync`,
    );
  }

  /**
   * Detailed sync activity — bytes transferred per direction, queue
   * size, current action, blob-transfer state. Polled while a sync is
   * in flight to drive progress UI.
   */
  async syncProgress(repoId: string, workspaceId: string): Promise<WorkspaceSyncProgress> {
    return this.getJson<WorkspaceSyncProgress>(
      `/repo/${encodeURIComponent(repoId)}/workspace/${encodeURIComponent(workspaceId)}/sync/progress`,
    );
  }

  /**
   * Wake the agent to re-scan and sync NOW. The agent normally
   * filesystem-watches on its own, but in cases where we *know* a
   * change just landed (e.g. right after a commit) calling this
   * shortens the time before the agent picks it up — without the
   * subprocess cost of `dv update`.
   */
  async notifySyncRequired(repoId: string, workspaceId: string): Promise<void> {
    await this.postNoBody(
      `/repo/${encodeURIComponent(repoId)}/workspace/${encodeURIComponent(workspaceId)}/sync`,
    );
  }

  /**
   * Per-file sync status for up to 10 paths at a time (agent-side cap
   * on the query string). Paths are repo-relative.
   */
  async fileSyncStatus(
    repoId: string,
    workspaceId: string,
    paths: readonly string[],
  ): Promise<FileSyncStatus[]> {
    if (paths.length === 0) return [];
    const qs = paths.map((p) => `Paths=${encodeURIComponent(p)}`).join('&');
    return this.getJson<FileSyncStatus[]>(
      `/repo/${encodeURIComponent(repoId)}/workspace/${encodeURIComponent(workspaceId)}/files/status?${qs}`,
    );
  }

  /** Resolves the base URL. Callers can use this to log what's in use. */
  async baseUrl(): Promise<string> {
    if (this.explicitBaseUrl) return this.explicitBaseUrl;
    if (this.cachedBaseUrl) return this.cachedBaseUrl;
    const portFile = path.join(this.home, '.port');
    let raw: string;
    try {
      raw = (await fs.readFile(portFile, 'utf8')).trim();
    } catch (err) {
      throw new DaemonUnavailableError(
        `Diversion daemon port file not found at ${portFile}. Is the dv daemon running?`,
        err,
      );
    }
    const port = Number.parseInt(raw, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new DaemonUnavailableError(`Invalid port in ${portFile}: ${raw}`);
    }
    this.cachedBaseUrl = `http://127.0.0.1:${port}`;
    return this.cachedBaseUrl;
  }

  private async getJson<T>(pathname: string): Promise<T> {
    const base = await this.baseUrl();
    const url = base + pathname;
    return new Promise<T>((resolve, reject) => {
      const req = http.get(url, { timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new DaemonUnavailableError(
              `${pathname} → HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
            ));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(new DaemonUnavailableError(
              `Failed to parse JSON from ${pathname}: ${(err as Error).message}`,
              err,
            ));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error(`timeout after ${this.timeoutMs}ms`));
      });
      req.on('error', (err) => {
        // Reset cached base URL on connection error — port may have changed.
        this.cachedBaseUrl = undefined;
        reject(new DaemonUnavailableError(
          `Daemon request to ${pathname} failed: ${err.message}`,
          err,
        ));
      });
    });
  }

  /**
   * Fire-and-forget POST with no request/response body — used for the
   * NotifySyncRequired endpoint. Treats any 2xx as success and any
   * other status as a fault, but doesn't try to parse the body.
   */
  private async postNoBody(pathname: string): Promise<void> {
    const base = await this.baseUrl();
    const target = new URL(base + pathname);
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: 'POST',
          timeout: this.timeoutMs,
          headers: { 'content-length': '0' },
        },
        (res) => {
          // Drain the body so the socket can be reused.
          res.on('data', () => { /* discard */ });
          res.on('end', () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new DaemonUnavailableError(`${pathname} → HTTP ${code}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeoutMs}ms`)));
      req.on('error', (err) => {
        this.cachedBaseUrl = undefined;
        reject(new DaemonUnavailableError(
          `Daemon request to ${pathname} failed: ${err.message}`,
          err,
        ));
      });
      req.end();
    });
  }
}
