import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitContentUri } from './commitContent.js';
import { formatCommitTooltip } from '../diversion/commitTooltip.js';
import type { Repo } from '../diversion/repo.js';
import type { CommitDetails } from '../diversion/types.js';
import type { Logger } from '../util/log.js';

/**
 * Implements the (proposed) `SourceControlHistoryProvider` API so the
 * built-in **Source Control Graph** view in the SCM panel populates with
 * Diversion commits, branches, and per-commit file changes.
 *
 * Requires `enabledApiProposals: ["scmHistoryProvider"]` in package.json
 * AND the user running with `--enable-proposed-api mtuska.diversion-vscode`
 * (or VS Code Insiders). When the proposal stabilises this file's typings
 * move from `types/vscode.proposed.scmHistoryProvider.d.ts` to the standard
 * `@types/vscode` and we drop the opt-in.
 *
 * Diversion-specific notes:
 * - Refs are branches (CoreAPI) plus tags (`dv tag --json`), in the
 *   `branches` and `tags` categories respectively.
 * - `provideHistoryItems` reads commits from the CoreAPI and tolerates skip
 *   via `options.skip` by over-fetching and slicing — there is no skip
 *   parameter on the commits endpoint we can push down.
 * - `provideHistoryItemChanges` uses the CoreAPI compare endpoint for the
 *   file list, then resolves each side lazily through the `dv-commit:`
 *   content provider when the user opens a file.
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

  /**
   * Fire when the set of refs changes — branches created / deleted
   * (`added`/`removed`) or a branch tip moving (`modified`, e.g. after
   * a commit). VS Code listens to this event to re-query the graph,
   * so it must fire whenever a new commit lands so the new entry
   * shows up without the user clicking refresh.
   */
  notifyRefsChanged(opts: {
    added?: vscode.SourceControlHistoryItemRef[];
    removed?: vscode.SourceControlHistoryItemRef[];
    modified?: vscode.SourceControlHistoryItemRef[];
  } = {}): void {
    this._onDidChangeHistoryItemRefs.fire({
      added: opts.added ?? [],
      removed: opts.removed ?? [],
      modified: opts.modified ?? [],
      silent: false,
    });
  }

  async provideHistoryItemRefs(
    _historyItemRefs: string[] | undefined,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SourceControlHistoryItemRef[]> {
    try {
      // Tags are a separate CLI round-trip and strictly decorative here, so a
      // tag failure must not cost us the branch refs the graph actually needs
      // to draw itself.
      const [branches, tags] = await Promise.all([
        this.repo.listBranches(),
        this.repo.listTags().catch((err) => {
          this.logger.warn(`[history] listTags failed: ${(err as Error).message}`);
          return [];
        }),
      ]);
      const refs: vscode.SourceControlHistoryItemRef[] = branches.map((b) => ({
        id: `branch:${b.name}`,
        name: b.name,
        description: b.id,
        revision: b.commitId,
        category: 'branches',
        icon: new vscode.ThemeIcon('git-branch'),
      }));
      for (const t of tags) {
        // A tag with no resolvable commit can't be placed on the graph.
        if (!t.commitId) continue;
        refs.push({
          id: `tag:${t.id}`,
          name: t.name,
          description: t.description || t.id,
          revision: t.commitId,
          category: 'tags',
          icon: new vscode.ThemeIcon('tag'),
        });
      }
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

    const tStart = Date.now();
    try {
      const commits = await this.repo.logFull(fetch);
      const tAfterLog = Date.now();
      this.logger.info(
        `[history] provideHistoryItems(limit=${limit}, skip=${skip}) · ` +
        `dv log=${tAfterLog - tStart}ms (${commits.length} commit(s))`
      );
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
          tooltip: buildTooltip(c),
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
    // Wrap in withProgress so the user gets visible feedback while dv chews
    // through `dv show` + the two `dv diff` prefetches. SourceControl is the
    // right location — the spinner shows in the SCM panel's title bar where
    // the click originated, and falls away as soon as the file list lands.
    // ProgressLocation.SourceControl puts a spinner on the SCM activity bar
    // icon — visible whether the SCM panel is open or not. We mirror it via
    // ProgressLocation.Window so users with the status bar in view still see
    // *something* without a modal popup interrupting them.
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: `Diversion: loading ${shortId(historyItemId)}…`,
      },
      () => vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Diversion: loading commit ${shortId(historyItemId)}`,
        },
        () => this.loadHistoryItemChanges(historyItemId, historyItemParentId),
      ),
    );
  }

  private async loadHistoryItemChanges(
    historyItemId: string,
    historyItemParentId: string | undefined,
  ): Promise<vscode.SourceControlHistoryItemChange[]> {
    const tStart = Date.now();
    try {
      // We only need `dv show --name-status` here — fast (<1s typically).
      // Returning the file list quickly lets VS Code render the tree
      // immediately. Per-file diff content is resolved lazily by the
      // `dv-commit:` content provider when the user actually opens a file
      // (1× `dv diff --base <commit> <single-path>` per file). The shared
      // dv semaphore caps concurrent loads to `diversion.maxParallelProcesses`.
      //
      // We tried bulk prefetching (one dv diff covering every file in the
      // commit) but on big commits it was a 30–60s wall — a wait the user
      // pays before seeing *anything*. Lazy resolution shifts that cost to
      // only the files the user actually clicks, which is normally a tiny
      // fraction of the commit.
      const changes = await this.repo.fileChangesForCommit(historyItemId);
      this.logger.info(
        `[history] provideHistoryItemChanges(${historyItemId}) · ` +
        `total=${Date.now() - tStart}ms (${changes.length} file(s), lazy)`,
      );
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

/** Wrap the pure formatter in a MarkdownString for the graph's hover. */
function buildTooltip(c: CommitDetails): vscode.MarkdownString {
  const md = new vscode.MarkdownString(formatCommitTooltip(c));
  // The message is arbitrary user content: never let it render command links.
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
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
