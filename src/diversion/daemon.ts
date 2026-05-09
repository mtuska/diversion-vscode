import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as vscode from 'vscode';
import type { DaemonHealth, DaemonWorkspaces } from './types.js';

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
 * Thin HTTP client for the local Diversion daemon. The daemon listens on a
 * loopback port published in `~/.diversion/.port`; the only endpoints we rely
 * on (verified against dv v0.9.895) are `/health` and `/workspaces`.
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

  async health(): Promise<DaemonHealth> {
    return this.getJson<DaemonHealth>('/health');
  }

  async workspaces(): Promise<DaemonWorkspaces> {
    return this.getJson<DaemonWorkspaces>('/workspaces');
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
}

/** Build a DaemonClient honoring the diversion.daemonUrl setting. */
export function daemonClientFromSettings(): DaemonClient {
  const cfg = vscode.workspace.getConfiguration('diversion');
  const url = cfg.get<string>('daemonUrl', '').trim();
  return new DaemonClient(url ? { baseUrl: url } : {});
}
