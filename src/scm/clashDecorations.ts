import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInsideOrEqual } from '../util/path.js';
import { formatRelative } from '../util/dates.js';
import type { Repo } from '../diversion/repo.js';
import type { ClashingEdit } from '../diversion/types.js';
import type { Logger } from '../util/log.js';

/**
 * Warns that someone else is already working on a file.
 *
 * This is the *advisory* counterpart to `dv lock`: it can't stop anyone, and
 * it needs no paid tier. It matters most for binary assets, where no
 * per-block merge UI can help once both sides have diverged — the only real
 * fix is finding out before you start.
 *
 * Deliberately cheap: refreshes are driven by decoration requests (so we only
 * ask about repos the user is actually looking at) behind a one-minute TTL in
 * `Repo`, rather than a background timer polling every open repo forever.
 */
export class ClashDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** repo root → workspace-relative path → the clashes on it. */
  private byRepo = new Map<string, Map<string, ClashingEdit[]>>();
  private inFlight = new Map<string, Promise<void>>();
  /** Files we've already warned about, so a session nags at most once each. */
  private readonly warned = new Set<string>();
  /** Total clashing paths across all repos — the fast bail for notifyEditing. */
  private totalClashes = 0;

  constructor(
    private readonly repos: () => Iterable<Repo>,
    private readonly logger: Logger,
    private readonly isEnabled: () => boolean,
  ) {}

  /**
   * Re-query every repo, bypassing the TTL. When the feature has just been
   * turned off this drops the snapshot and repaints instead: returning early
   * would leave VS Code's cached badges on screen with no event to clear them.
   */
  async refresh(): Promise<void> {
    if (!this.isEnabled()) {
      const hadAny = this.totalClashes > 0;
      this.byRepo.clear();
      this.warned.clear();
      this.totalClashes = 0;
      if (hadAny) this._onDidChange.fire(undefined);
      return;
    }
    await Promise.all([...this.repos()].map((repo) => {
      repo.invalidateClashCache();
      return this.doRefresh(repo);
    }));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file' || !this.isEnabled()) return undefined;
    const match = this.findRepo(uri.fsPath);
    if (!match) return undefined;

    const map = this.byRepo.get(match.root);
    if (!map) {
      // No snapshot yet — fetch in the background; the change event re-asks.
      void this.ensureFresh(match.repo);
      return undefined;
    }
    const clashes = map.get(path.relative(match.root, uri.fsPath));
    if (!clashes || clashes.length === 0) return undefined;

    return {
      badge: '👥',
      // Warning, not error: locks use errorForeground for "you cannot modify
      // this". A clash is "you can, but talk to someone first".
      color: new vscode.ThemeColor('list.warningForeground'),
      tooltip: describeClashes(clashes),
      propagate: false,
    };
  }

  /**
   * Warn once when the user starts editing a file someone else is on. The
   * decoration covers browsing; this covers the moment that actually creates
   * the divergence.
   */
  notifyEditing(uri: vscode.Uri): void {
    // Runs on every keystroke in every document, so the common case — nobody
    // is clashing with anything — must cost close to nothing. `totalClashes`
    // is maintained on refresh precisely so we can bail before walking repos.
    if (this.totalClashes === 0) return;
    if (uri.scheme !== 'file' || !this.isEnabled()) return;
    if (this.warned.has(uri.fsPath)) return;
    const match = this.findRepo(uri.fsPath);
    if (!match) return;
    const clashes = this.byRepo.get(match.root)?.get(path.relative(match.root, uri.fsPath));
    if (!clashes || clashes.length === 0) return;

    this.warned.add(uri.fsPath);
    const who = [...new Set(clashes.map((c) => c.author))].join(', ');
    void vscode.window.showWarningMessage(
      `Diversion: ${path.basename(uri.fsPath)} is also being edited by ${who}.`,
      'Show Details', 'Lock File',
    ).then((pick) => {
      if (pick === 'Show Details') {
        void vscode.window.showInformationMessage(describeClashes(clashes), { modal: true });
      } else if (pick === 'Lock File') {
        void vscode.commands.executeCommand('diversion.lockFile', uri);
      }
    });
  }

  private findRepo(fsPath: string): { repo: Repo; root: string } | undefined {
    for (const repo of this.repos()) {
      if (isInsideOrEqual(repo.root, fsPath)) return { repo, root: repo.root };
    }
    return undefined;
  }

  private async ensureFresh(repo: Repo): Promise<void> {
    const existing = this.inFlight.get(repo.root);
    if (existing) return existing;
    const p = this.doRefresh(repo).finally(() => this.inFlight.delete(repo.root));
    this.inFlight.set(repo.root, p);
    await p;
  }

  private async doRefresh(repo: Repo): Promise<void> {
    const root = repo.root;
    try {
      // Repo.clashingEdits is TTL-cached, so this is usually free.
      const clashes = await repo.clashingEdits();
      const map = new Map<string, ClashingEdit[]>();
      for (const clash of clashes) {
        const list = map.get(clash.path);
        if (list) list.push(clash);
        else map.set(clash.path, [clash]);
      }
      const previous = this.byRepo.get(root);
      this.byRepo.set(root, map);
      this.totalClashes = [...this.byRepo.values()].reduce((n, m) => n + m.size, 0);
      const changed = changedPaths(previous, map).map((p) => vscode.Uri.file(path.join(root, p)));
      if (changed.length > 0) this._onDidChange.fire(changed);
    } catch (err) {
      // Expected on older backends or when offline. Debug, not warn — this is
      // an optional signal and a noisy log would train people to ignore it.
      this.logger.debug(`[clash] refresh failed for ${root}: ${(err as Error).message}`);
      // Record an empty snapshot so we don't re-request on every decoration.
      if (!this.byRepo.has(root)) this.byRepo.set(root, new Map());
    }
  }

  dispose(): void { this._onDidChange.dispose(); }
}

function describeClashes(clashes: readonly ClashingEdit[]): string {
  return clashes.map((c) => {
    const where = c.branchName ? ` on ${c.branchName}` : '';
    const when = c.mtime ? `, ${formatRelative(new Date(c.mtime).toISOString())}` : '';
    const what = c.workspaceId ? 'uncommitted' : c.kind;
    return `${c.author}${where} — ${what}${when}`;
  }).join('\n');
}

/** Paths whose clash set differs between two snapshots. */
function changedPaths(
  prev: Map<string, ClashingEdit[]> | undefined,
  next: Map<string, ClashingEdit[]>,
): string[] {
  const out: string[] = [];
  if (prev) for (const k of prev.keys()) if (!next.has(k)) out.push(k);
  for (const [k, v] of next) {
    const before = prev?.get(k);
    if (!before || before.length !== v.length) { out.push(k); continue; }
    const key = (list: readonly ClashingEdit[]): string =>
      list.map((c) => `${c.author}\t${c.kind}\t${c.branchName ?? ''}`).sort().join('|');
    if (key(before) !== key(v)) out.push(k);
  }
  return out;
}
