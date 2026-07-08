import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInsideOrEqual } from '../util/path.js';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';

const REFRESH_TTL_MS = 5_000;

/**
 * Decorates locked files in the explorer with a 🔒 badge. Resolves locks
 * lazily through `dv lock` (cached for 5s in `Repo`) and falls back to no
 * decoration on error.
 *
 * Holder identity isn't currently exposed by the daemon's HTTP surface, so
 * we can't tell "locked by you" from "locked by someone else" without the
 * `dv` user identity — for now both render with the same badge but the
 * tooltip identifies the holder when known.
 */
export class LockDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** Map of repo root → set of locked workspace-relative paths. */
  private byRepo = new Map<string, Map<string, string | undefined>>();
  private lastRefresh = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly repos: () => Iterable<Repo>,
    private readonly logger: Logger,
  ) {}

  /**
   * Force-refresh the lock cache for every repo. Called after lock/unlock
   * commands — bypasses the TTL so the change shows immediately. `doRefresh`
   * fires a precise per-URI delta; we deliberately do NOT fire `undefined`
   * (invalidate-all), which would make VS Code re-query decorations for every
   * visible file.
   */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.repos()].map((repo) => {
        repo.invalidateLockCache();
        this.lastRefresh.delete(repo.root); // defeat the TTL guard in ensureFresh
        return this.ensureFresh(repo);
      }),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file') return undefined;
    const match = this.findRepo(uri.fsPath);
    if (!match) return undefined;

    const map = this.byRepo.get(match.root);
    const rel = path.relative(match.root, uri.fsPath);
    const holder = map?.get(rel);
    if (holder === undefined && !map?.has(rel)) {
      // Not in the snapshot — kick a refresh in the background and return no
      // decoration for this call. The next change event re-asks us.
      void this.ensureFresh(match.repo);
      return undefined;
    }
    return {
      badge: '🔒',
      // Tint locked files so they're distinguishable at a glance even
      // when other decorations (M/A/D badges in SCM, the emoji is
      // also small) would otherwise dominate. `errorForeground` is
      // the closest semantic match — locked = "you cannot modify this
      // right now" — and reads well in both the explorer and the SCM
      // resource list.
      color: new vscode.ThemeColor('errorForeground'),
      tooltip: holder ? `Locked by ${holder}` : 'Locked',
      propagate: false,
    };
  }

  private findRepo(fsPath: string): { repo: Repo; root: string } | undefined {
    for (const repo of this.repos()) {
      if (isInsideOrEqual(repo.root, fsPath)) {
        return { repo, root: repo.root };
      }
    }
    return undefined;
  }

  private async ensureFresh(repo: Repo): Promise<void> {
    const root = repo.root;
    const now = Date.now();
    if ((this.lastRefresh.get(root) ?? 0) + REFRESH_TTL_MS > now) return;
    if (this.inFlight.has(root)) return;
    const p = this.doRefresh(repo).finally(() => this.inFlight.delete(root));
    this.inFlight.set(root, p);
    await p;
  }

  private async doRefresh(repo: Repo): Promise<void> {
    const root = repo.root;
    try {
      const locks = await repo.listLocks();
      const map = new Map<string, string | undefined>();
      for (const lock of locks) map.set(lock.path, lock.holder);
      const previous = this.byRepo.get(root);
      this.byRepo.set(root, map);
      this.lastRefresh.set(root, Date.now());
      const changed = computeChanged(previous, map).map((p) =>
        vscode.Uri.file(path.join(root, p)),
      );
      if (changed.length > 0) this._onDidChange.fire(changed);
    } catch (err) {
      this.logger.warn(`[locks] refresh failed for ${root}: ${(err as Error).message}`);
    }
  }

  dispose(): void { this._onDidChange.dispose(); }
}

function computeChanged(
  prev: Map<string, string | undefined> | undefined,
  next: Map<string, string | undefined>,
): string[] {
  const out: string[] = [];
  if (prev) for (const k of prev.keys()) if (!next.has(k)) out.push(k);
  for (const [k, v] of next) {
    if (!prev || prev.get(k) !== v) out.push(k);
  }
  return out;
}
