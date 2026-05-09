import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitContentUri } from './commitContent.js';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';

/**
 * Implements the (proposed) `SourceControlHistoryProvider` API so the
 * built-in **Source Control Graph** view in the SCM panel populates with
 * Diversion commits, branches, and per-commit file changes.
 *
 * Requires `enabledApiProposals: ["scmHistoryProvider"]` in package.json
 * AND the user running with `--enable-proposed-api diversion.diversion-vscode`
 * (or VS Code Insiders). When the proposal stabilises this file's typings
 * move from `types/vscode.proposed.scmHistoryProvider.d.ts` to the standard
 * `@types/vscode` and we drop the opt-in.
 *
 * Diversion-specific notes:
 * - Refs are branches from `dv branch`. Tags exist (`dv tag`) but aren't
 *   surfaced yet — straightforward follow-up.
 * - `provideHistoryItems` calls `dv log -n <limit>` and tolerates skip via
 *   `options.skip` (we re-run with a larger limit and slice; dv has no
 *   --skip flag as of v0.9.895).
 * - `provideHistoryItemChanges` calls `dv show <id> --name-status`.
 *   `originalUri` / `modifiedUri` are left undefined for now — the Graph
 *   still renders the file list; clicking opens the working file. Proper
 *   per-commit content URIs require a `dv-commit:<id>:<path>` scheme that
 *   resolves via cached `dv restore` output, planned for v0.4.
 */
export class DiversionHistoryProvider implements vscode.SourceControlHistoryProvider {
  private readonly _onDidChangeCurrentHistoryItemRefs = new vscode.EventEmitter<void>();
  readonly onDidChangeCurrentHistoryItemRefs = this._onDidChangeCurrentHistoryItemRefs.event;

  private readonly _onDidChangeHistoryItemRefs = new vscode.EventEmitter<vscode.SourceControlHistoryItemRefsChangeEvent>();
  readonly onDidChangeHistoryItemRefs = this._onDidChangeHistoryItemRefs.event;

  private knownRefs = new Map<string, vscode.SourceControlHistoryItemRef>();

  constructor(
    private readonly repo: Repo,
    private readonly logger: Logger,
  ) {}

  // Convenience accessors used both by the API and by callers in extension.ts.
  get currentHistoryItemRef(): vscode.SourceControlHistoryItemRef | undefined {
    const id = this.repo.info.branchName;
    if (!id) return undefined;
    return {
      id: `branch:${id}`,
      name: id,
      revision: this.repo.info.commitId,
      category: 'branches',
      icon: new vscode.ThemeIcon('git-branch'),
    };
  }

  get currentHistoryItemRemoteRef(): vscode.SourceControlHistoryItemRef | undefined { return undefined; }
  get currentHistoryItemBaseRef(): vscode.SourceControlHistoryItemRef | undefined { return undefined; }

  /** Fire when the workspace's current branch / commit changes. */
  notifyCurrentChanged(): void {
    this._onDidChangeCurrentHistoryItemRefs.fire();
  }

  /** Fire when the set of branches changes (e.g. created / deleted). */
  notifyRefsChanged(added: vscode.SourceControlHistoryItemRef[] = [], removed: vscode.SourceControlHistoryItemRef[] = []): void {
    this._onDidChangeHistoryItemRefs.fire({ added, removed, modified: [], silent: false });
  }

  async provideHistoryItemRefs(
    _historyItemRefs: string[] | undefined,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItemRef[]> {
    try {
      const branches = await this.repo.listBranches();
      const refs: vscode.SourceControlHistoryItemRef[] = branches.map((b) => ({
        id: `branch:${b.name}`,
        name: b.name,
        description: b.id,
        revision: b.commitId,
        category: 'branches',
        icon: new vscode.ThemeIcon('git-branch'),
      }));
      this.knownRefs = new Map(refs.map((r) => [r.id, r]));
      return refs;
    } catch (err) {
      this.logger.warn(`[history] provideHistoryItemRefs failed: ${(err as Error).message}`);
      return [];
    }
  }

  async provideHistoryItems(
    options: vscode.SourceControlHistoryOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItem[]> {
    const limit = typeof options.limit === 'number' ? options.limit : 100;
    const skip = options.skip ?? 0;
    const fetch = limit + skip;

    try {
      const commits = await this.repo.logFull(fetch);
      const sliced = commits.slice(skip, skip + limit);

      // Pre-compute branch refs by tip-commit so we can attach them to the
      // matching history items.
      const refsByCommit = new Map<string, vscode.SourceControlHistoryItemRef[]>();
      for (const ref of this.knownRefs.values()) {
        if (!ref.revision) continue;
        const arr = refsByCommit.get(ref.revision) ?? [];
        arr.push(ref);
        refsByCommit.set(ref.revision, arr);
      }

      return sliced.map((c, i): vscode.SourceControlHistoryItem => {
        // Linear chain: parent is the next-older commit in our slice unless
        // dv printed a `Merge:` line, in which case we have at least one
        // additional parent. dv currently only prints one merge parent —
        // we add it alongside the linear predecessor.
        const linearParent = sliced[i + 1]?.id;
        const parentIds: string[] = [];
        if (linearParent) parentIds.push(linearParent);
        if (c.merge?.commitId && !parentIds.includes(c.merge.commitId)) {
          parentIds.push(c.merge.commitId);
        }

        const subject = c.message.split('\n', 1)[0] ?? '';
        const timestamp = parseTimestampMillis(c.date);

        return {
          id: c.id,
          parentIds,
          subject,
          message: c.message,
          displayId: shortId(c.id),
          author: c.authorName,
          authorEmail: c.authorEmail,
          timestamp,
          references: refsByCommit.get(c.id),
        };
      });
    } catch (err) {
      this.logger.warn(`[history] provideHistoryItems failed: ${(err as Error).message}`);
      return [];
    }
  }

  async provideHistoryItemChanges(
    historyItemId: string,
    historyItemParentId: string | undefined,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItemChange[]> {
    try {
      const changes = await this.repo.fileChangesForCommit(historyItemId);
      // The "parent" for diff purposes is the linear predecessor — we
      // reuse the parentId VS Code passes us if it's there, otherwise we
      // omit originalUri (added/no-prior-version case).
      return changes.map((c): vscode.SourceControlHistoryItemChange => {
        const absPath = path.join(this.repo.root, c.path);
        const fileUri = vscode.Uri.file(absPath);

        // For "added" we have no parent version to show; for "deleted" we
        // have no current version. Otherwise both sides resolve through
        // the dv-commit: scheme.
        const isAdded = c.kind === 'added';
        const isDeleted = c.kind === 'deleted';
        const original = !isAdded && historyItemParentId
          ? commitContentUri(absPath, historyItemParentId)
          : undefined;
        const modified = !isDeleted
          ? commitContentUri(absPath, historyItemId)
          : undefined;

        return {
          uri: fileUri,
          originalUri: original,
          modifiedUri: modified,
        };
      });
    } catch (err) {
      this.logger.warn(`[history] provideHistoryItemChanges failed for ${historyItemId}: ${(err as Error).message}`);
      return [];
    }
  }
}

function parseTimestampMillis(raw: string): number | undefined {
  if (!raw) return undefined;
  // `dv log --date iso` prints e.g. "2026-04-11T20:42:03Z" — Date.parse handles it.
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function shortId(id: string): string {
  // `dv.commit.<n>` — the suffix is short enough already; trim the prefix.
  const m = /\.([\w-]+)$/.exec(id);
  return m ? m[1]! : id;
}
