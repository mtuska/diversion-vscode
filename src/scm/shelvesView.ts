import * as vscode from 'vscode';
import type { Repo } from '../diversion/repo.js';
import type { ShelfInfo } from '../diversion/types.js';
import type { Logger } from '../util/log.js';

/**
 * Tree-data provider for the **Shelves** view registered alongside the
 * Source Control panel. Each top-level node is a repo; expanding shows the
 * shelves for that repo. `dv shelf` is invoked lazily and re-cached on the
 * first refresh after an apply/delete/create.
 */
export class ShelvesTreeProvider implements vscode.TreeDataProvider<ShelfNode> {
  private readonly _onDidChange = new vscode.EventEmitter<ShelfNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly repos: () => Iterable<Repo>,
    private readonly logger: Logger,
  ) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  getTreeItem(node: ShelfNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'diversion.shelfRepo';
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = node.root;
      return item;
    }
    if (node.kind === 'shelf') {
      const item = new vscode.TreeItem(node.shelf.name, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'diversion.shelf';
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = node.shelf.description;
      item.tooltip = node.shelf.raw;
      item.id = `${node.repoRoot}::${node.shelf.id ?? node.shelf.name}`;
      return item;
    }
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('No shelves', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('inbox');
      item.contextValue = 'diversion.shelfEmpty';
      return item;
    }
    if (node.kind === 'error') {
      const item = new vscode.TreeItem(`(error: ${node.message})`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    return new vscode.TreeItem('?');
  }

  async getChildren(node?: ShelfNode): Promise<ShelfNode[]> {
    if (!node) {
      const repos = [...this.repos()];
      if (repos.length === 0) return [];
      if (repos.length === 1) {
        // Single repo — skip the repo row, render shelves directly.
        return this.shelvesFor(repos[0]!);
      }
      return repos.map((r) => ({
        kind: 'repo' as const,
        repoName: r.info.repoName,
        root: r.root,
        repo: r,
      }));
    }
    if (node.kind === 'repo') return this.shelvesFor(node.repo);
    return [];
  }

  private async shelvesFor(repo: Repo): Promise<ShelfNode[]> {
    try {
      const shelves = await repo.listShelves();
      if (shelves.length === 0) return [{ kind: 'empty' }];
      return shelves.map((s) => ({ kind: 'shelf' as const, shelf: s, repoRoot: repo.root, repo }));
    } catch (err) {
      this.logger.warn(`[shelves] list failed for ${repo.root}: ${(err as Error).message}`);
      return [{ kind: 'error' as const, message: (err as Error).message }];
    }
  }
}

export type ShelfNode =
  | { kind: 'repo'; repoName: string; root: string; repo: Repo }
  | { kind: 'shelf'; shelf: ShelfInfo; repoRoot: string; repo: Repo }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };
