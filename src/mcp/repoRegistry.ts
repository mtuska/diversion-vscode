import * as path from 'node:path';
import { DaemonClient } from '../diversion/daemon.js';
import { detectRepo, findDiversionRoot } from '../diversion/detect.js';
import { Repo } from '../diversion/repo.js';
import { isInsideOrEqual } from '../util/path.js';
import type { LoggerLike } from '../util/logCore.js';

export interface RepoRegistryOptions {
  /** Override the dv binary location. Empty / undefined uses PATH lookup. */
  dvPath?: string;
  /** Override the daemon base URL. Empty / undefined uses port-file discovery. */
  daemonUrl?: string;
  /** Override the CoreAPI base URL. Empty / undefined uses the production endpoint. */
  coreApiUrl?: string;
  /** CoreAPI access token supplied by the operator (DIVERSION_CORE_TOKEN). */
  coreAccessToken?: string;
}

/**
 * Tracks one or more Diversion repos and resolves the "which repo did the
 * caller mean?" question that every tool invocation has to answer. The
 * extension does this same job through its `providers` map; the MCP
 * server, having no VS Code state to lean on, owns its own registry.
 *
 * Resolution rules (in order):
 *   1. If only one repo is registered, return it.
 *   2. If the hint matches a registered repo's name, return it.
 *   3. If the hint resolves to an absolute path inside a registered
 *      repo's root, return that repo.
 *   4. Try `findDiversionRoot(hint)` and register on the fly. This lets
 *      callers pass any directory and have us locate the enclosing repo.
 */
export class RepoRegistry {
  private readonly daemon: DaemonClient;
  private readonly dvPath: string | undefined;
  private readonly coreApiUrl: string | undefined;
  private readonly coreAccessToken: string | undefined;
  private readonly repos = new Map<string, Repo>();

  constructor(
    private readonly logger: LoggerLike,
    opts: RepoRegistryOptions,
  ) {
    this.dvPath = opts.dvPath?.trim() || undefined;
    this.coreApiUrl = opts.coreApiUrl?.trim() || undefined;
    this.coreAccessToken = opts.coreAccessToken?.trim() || undefined;
    this.daemon = new DaemonClient(opts.daemonUrl?.trim() ? { baseUrl: opts.daemonUrl.trim() } : {});
  }

  /**
   * Run startup discovery — daemon registry first, CWD as a fallback.
   * Idempotent. Returns the count of repos registered.
   *
   * Unlike git, Diversion has a centralized agent that tracks every
   * workspace on the machine, so we don't ask the user to declare roots
   * up front. Anything reachable via the agent registry shows up here;
   * anything that isn't can still be reached on-the-fly through `pick`
   * by passing a path as the `repo` argument.
   */
  async discover(): Promise<number> {
    // Daemon registry — authoritative when reachable.
    try {
      const workspaces = await this.daemon.workspaces();
      for (const ws of Object.values(workspaces)) {
        await this.registerRoot(ws.Path).catch(() => undefined);
      }
    } catch (err) {
      this.logger.debug(`Daemon unreachable during discovery: ${(err as Error).message}`);
    }

    // CWD fallback — common when the agent is offline and the user
    // launched the server from inside a checkout.
    if (this.repos.size === 0) {
      const fromCwd = await findDiversionRoot(process.cwd());
      if (fromCwd) await this.registerRoot(fromCwd).catch(() => undefined);
    }

    this.logger.info(`MCP registry: ${this.repos.size} repo(s) registered`);
    for (const r of this.repos.values()) {
      this.logger.info(`  • ${r.info.repoName} @ ${r.root} (branch: ${r.info.branchName || '<unknown>'})`);
    }
    return this.repos.size;
  }

  /**
   * Register the Diversion repo at `root` if one is there (or any
   * ancestor of it). Returns the registered Repo or undefined if none
   * was found.
   */
  async registerRoot(root: string): Promise<Repo | undefined> {
    const resolved = path.resolve(root);
    if (this.repos.has(resolved)) return this.repos.get(resolved);
    const repoRoot = await findDiversionRoot(resolved);
    if (!repoRoot) return undefined;
    if (this.repos.has(repoRoot)) return this.repos.get(repoRoot);

    const identity = await detectRepo(this.daemon, repoRoot);
    if (!identity) return undefined;
    const repo = new Repo(this.daemon, identity, this.dvPath, this.logger, {
      ...(this.coreApiUrl ? { baseUrl: this.coreApiUrl } : {}),
      ...(this.coreAccessToken ? { accessToken: this.coreAccessToken } : {}),
    });
    this.repos.set(repoRoot, repo);
    return repo;
  }

  /** All currently registered repos, in insertion order. */
  list(): Repo[] {
    return [...this.repos.values()];
  }

  /**
   * Locate the repo matching `hint`, or pick a default. Throws on
   * ambiguity / no-match so the caller can return the diagnostic to the
   * MCP client unmodified.
   */
  async pick(hint?: string): Promise<Repo> {
    const all = this.list();
    if (all.length === 0) {
      const tryCwd = await this.registerRoot(process.cwd());
      if (tryCwd) return tryCwd;
      throw new Error(
        'No Diversion repositories are registered. Pass the "repo" argument with ' +
        'a repo name or an absolute path inside the repo, or set DIVERSION_REPO_ROOTS.',
      );
    }
    if (!hint) {
      if (all.length === 1) return all[0]!;
      const names = all.map((r) => r.info.repoName || r.root).join(', ');
      throw new Error(
        `Multiple Diversion repos available (${names}). Pass the "repo" argument — ` +
        `repo name or an absolute filesystem path inside the repo.`,
      );
    }
    for (const r of all) if (r.info.repoName === hint) return r;
    const norm = path.resolve(hint);
    for (const r of all) if (isInsideOrEqual(r.root, norm)) return r;
    const onTheFly = await this.registerRoot(norm);
    if (onTheFly) return onTheFly;
    const names = all.map((r) => r.info.repoName || r.root).join(', ');
    throw new Error(`No repo matched "${hint}". Available: ${names}.`);
  }

  /** Force a daemon-side identity refresh on every registered repo. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.list().map((r) => r.refreshIdentity().catch(() => undefined)));
  }
}
