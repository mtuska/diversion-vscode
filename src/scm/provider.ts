import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Repo } from '../diversion/repo.js';
import type { FileChange, ChangeKind } from '../diversion/types.js';
import type { Logger } from '../util/log.js';
import { DiversionHistoryProvider } from './historyProvider.js';
import type { ChangeDecorationsProvider } from './changeDecorations.js';
import { isInsideOrEqual } from '../util/path.js';

const PROVIDER_ID = 'diversion';

/**
 * SCM provider for one Diversion workspace. Owns a `vscode.SourceControl`,
 * its resource groups, and the refresh lifecycle.
 */
export class DiversionScmProvider implements vscode.Disposable {
  private readonly sc: vscode.SourceControl;
  private readonly groupStaged: vscode.SourceControlResourceGroup;
  private readonly groupChanges: vscode.SourceControlResourceGroup;
  private readonly groupConflicts: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Workspace-relative paths the user has explicitly "staged" for the next
   * commit. Diversion has no real staging area, so this is purely a UI
   * concept maintained per-workspace and persisted via `workspaceState`.
   * When commit fires with this set non-empty, we pass `dv commit <paths> -m`;
   * otherwise we use `dv commit -a -m`.
   */
  private readonly stagedPaths = new Set<string>();
  private readonly storageKey: string;
  private history: DiversionHistoryProvider | undefined;

  /**
   * Absolute filesystem paths of workspace folders the user has open that
   * resolve to this repo. When non-empty AND none of them equals the repo
   * root, SCM display is filtered to changes inside one of these folders —
   * so opening `RepoRoot/Subdir/` shows only `Documentation/*`
   * changes even though the provider is rooted at `RepoRoot/`. Empty (or
   * containing the repo root) means "show all changes".
   */
  private openFolders: string[] = [];

  private refreshTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private pendingRefresh = false;

  constructor(
    readonly repo: Repo,
    private readonly logger: Logger,
    private readonly storage: vscode.Memento,
    quickDiffProvider?: vscode.QuickDiffProvider,
    private readonly changeDecorations?: ChangeDecorationsProvider,
  ) {
    this.storageKey = `diversion.staged.${repo.info.workspaceId}`;
    const persisted = this.storage.get<string[]>(this.storageKey, []);
    for (const p of persisted) this.stagedPaths.add(p);
    if (persisted.length > 0) {
      this.logger.info(`[scm] restored ${persisted.length} staged path(s) from workspaceState`);
    }

    this.sc = vscode.scm.createSourceControl(
      PROVIDER_ID,
      `Diversion · ${repo.info.repoName || path.basename(repo.root)}`,
      vscode.Uri.file(repo.root),
    );
    this.sc.inputBox.placeholder = 'Message (Ctrl+Enter to commit)';
    this.sc.acceptInputCommand = {
      command: 'diversion.commit',
      title: 'Commit',
      arguments: [this.sc],
    };

    if (quickDiffProvider) {
      this.sc.quickDiffProvider = quickDiffProvider;
    }

    // Native Source Control Graph integration. Requires the proposed API
    // `scmHistoryProvider` (declared in package.json's enabledApiProposals).
    // We try-catch in case the runtime hasn't enabled the proposal — the
    // graph view simply won't populate, but the rest of the provider still
    // works. See historyProvider.ts for opt-in details.
    try {
      this.history = new DiversionHistoryProvider(this.repo, this.logger);
      // The `historyProvider` property is added by the proposed API; cast
      // through `any` so this still compiles when the proposal isn't loaded.
      (this.sc as { historyProvider?: DiversionHistoryProvider }).historyProvider = this.history;
    } catch (err) {
      this.logger.warn(`[scm] history provider unavailable: ${(err as Error).message}`);
    }

    // Order matches git's SCM convention: Conflicts → Staged → Changes
    // (the unstaged catch-all). What used to be "New" lives inside
    // Changes now, badged "A" via the FileDecorationProvider.
    this.groupConflicts = this.sc.createResourceGroup('conflicts', 'Conflicts');
    this.groupStaged = this.sc.createResourceGroup('staged', 'Staged Changes');
    this.groupChanges = this.sc.createResourceGroup('changes', 'Changes');
    this.groupConflicts.hideWhenEmpty = true;
    this.groupStaged.hideWhenEmpty = true;
    this.groupChanges.hideWhenEmpty = true;

    this.disposables.push(this.sc, this.groupConflicts, this.groupStaged, this.groupChanges);
  }

  get sourceControl(): vscode.SourceControl { return this.sc; }
  get root(): string { return this.repo.root; }

  /**
   * Tell the provider which absolute folder paths the user has open that
   * map to this repo. The provider filters its visible change list to those
   * folders. Pass an empty array (or one that includes the repo root) to
   * disable filtering.
   */
  setOpenFolders(folders: readonly string[]): void {
    const next = [...folders];
    const a = this.openFolders.slice().sort();
    const b = next.slice().sort();
    if (a.length === b.length && a.every((v, i) => v === b[i])) return;
    this.openFolders = next;
    this.scheduleRefresh(0);
  }

  /** True when the configured filter would hide a path. */
  private isPathVisible(relPath: string): boolean {
    if (this.openFolders.length === 0) return true;
    // If any open folder IS the repo root, no filtering.
    if (this.openFolders.some((f) => f === this.repo.root)) return true;
    const abs = path.join(this.repo.root, relPath);
    for (const folder of this.openFolders) {
      if (isInsideOrEqual(folder, abs)) return true;
    }
    return false;
  }

  /** Schedule a refresh; coalesces rapid successive calls via debounce. */
  scheduleRefresh(debounceMs: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, debounceMs);
  }

  /** Run a refresh now. Coalesces concurrent calls (latest one waits for in-flight). */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      this.pendingRefresh = true;
      return this.inFlight;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const before = {
        commitId: this.repo.info.commitId,
        branchName: this.repo.info.branchName,
      };

      const [state] = await Promise.all([
        this.repo.getState(),
        this.repo.refreshIdentity(),
      ]);

      // Drop any staged paths that no longer correspond to a change (e.g. the
      // user reverted the file or it was committed elsewhere). Persist if changed.
      const livePaths = new Set(state.changes.map((c) => c.path));
      let stagingChanged = false;
      for (const p of [...this.stagedPaths]) {
        if (!livePaths.has(p)) { this.stagedPaths.delete(p); stagingChanged = true; }
      }
      if (stagingChanged) this.persistStaged();

      const staged: vscode.SourceControlResourceState[] = [];
      const changes: vscode.SourceControlResourceState[] = [];
      const decorationStates = new Map<string, ChangeKind>();

      let hidden = 0;
      for (const change of state.changes) {
        // Decorations are populated for *every* changed file in the
        // repo, regardless of which workspace folders are open. The
        // open-folder filter only narrows the SCM panel listing —
        // applying it here too left the explorer un-decorated until
        // the user expanded down to each file.
        decorationStates.set(path.join(this.repo.root, change.path), change.kind);
        if (!this.isPathVisible(change.path)) { hidden++; continue; }
        const isStaged = this.stagedPaths.has(change.path);
        const rstate = toResourceState(this.repo.root, change, isStaged);
        if (isStaged) {
          staged.push(rstate);
        } else {
          changes.push(rstate);
        }
      }

      const conflicts: vscode.SourceControlResourceState[] = [];
      for (const c of state.conflicts) {
        const rel = path.relative(this.repo.root, c.originalPath);
        if (!this.isPathVisible(rel)) { hidden++; continue; }
        conflicts.push({
          resourceUri: vscode.Uri.file(c.originalPath),
          decorations: { tooltip: `Sync conflict — local copy at ${c.sidecarPath}` },
          contextValue: 'conflict',
          command: {
            command: 'diversion.resolveConflict',
            title: 'Resolve',
            arguments: [vscode.Uri.file(c.originalPath), vscode.Uri.file(c.sidecarPath)],
          },
        });
      }

      this.groupConflicts.resourceStates = conflicts;
      this.groupStaged.resourceStates = staged;
      this.groupChanges.resourceStates = changes;
      this.sc.count = conflicts.length + staged.length + changes.length;
      this.updateTitleButtons();
      this.history?.notifyCurrentChanged();
      // If the branch tip moved (commit, checkout, merge, etc.) tell
      // VS Code's graph view to re-query — `notifyCurrentChanged` only
      // updates the "current" indicator, not the commit list itself.
      const moved = this.repo.info.commitId !== before.commitId
        || this.repo.info.branchName !== before.branchName;
      if (moved) {
        const currentRef = this.history?.currentHistoryItemRef;
        this.history?.notifyRefsChanged(currentRef ? { modified: [currentRef] } : {});
      }
      this.changeDecorations?.setRepoState(this.repo.root, decorationStates);
      const filterNote = this.openFolders.length > 0 && hidden > 0
        ? ` (${hidden} hidden by open-folder filter: ${this.openFolders.join(', ')})`
        : '';
      this.logger.debug(
        `[scm] refresh: ${conflicts.length} conflicts + ${staged.length} staged + ${changes.length} changes${filterNote}`,
      );
    } catch (err) {
      this.logger.error(`[scm] refresh failed for ${this.repo.root}`, err);
    }
  }

  // ───── staging API ─────

  /** All currently-changed workspace-relative paths from the last refresh. */
  private allChangedPaths(): string[] {
    return this.getVisibleChangedPaths();
  }

  /**
   * Workspace-relative paths of every change the SCM panel is currently
   * displaying — i.e. after the open-folder filter has been applied.
   * Callers that want to operate on "what the user can actually see"
   * (commit, generate-commit-message, etc.) should use this instead of
   * the full repo diff so we don't act on changes outside their scope.
   */
  getVisibleChangedPaths(): string[] {
    const out = new Set<string>();
    for (const r of this.groupStaged.resourceStates) out.add(this.relPath(r.resourceUri));
    for (const r of this.groupChanges.resourceStates) out.add(this.relPath(r.resourceUri));
    return [...out];
  }

  /**
   * Live resource states from one of the SCM groups, used by
   * folder-row context-menu commands to expand a clicked folder into
   * the concrete files the underlying action needs (with their full
   * `contextValue`/`command` metadata intact).
   */
  getResourceStates(group: 'changes' | 'staged' | 'conflicts'): readonly vscode.SourceControlResourceState[] {
    switch (group) {
      case 'changes': return this.groupChanges.resourceStates;
      case 'staged': return this.groupStaged.resourceStates;
      case 'conflicts': return this.groupConflicts.resourceStates;
    }
  }

  /** Paths the user has staged for the next commit. */
  getStagedPaths(): string[] {
    return [...this.stagedPaths];
  }

  stage(paths: readonly string[]): void {
    let added = false;
    for (const p of paths) if (!this.stagedPaths.has(p)) { this.stagedPaths.add(p); added = true; }
    if (added) { this.persistStaged(); this.scheduleRefresh(0); }
  }

  unstage(paths: readonly string[]): void {
    let removed = false;
    for (const p of paths) if (this.stagedPaths.delete(p)) removed = true;
    if (removed) { this.persistStaged(); this.scheduleRefresh(0); }
  }

  stageAll(): void {
    let added = false;
    for (const p of this.allChangedPaths()) if (!this.stagedPaths.has(p)) { this.stagedPaths.add(p); added = true; }
    if (added) { this.persistStaged(); this.scheduleRefresh(0); }
  }

  unstageAll(): void {
    if (this.stagedPaths.size === 0) return;
    this.stagedPaths.clear();
    this.persistStaged();
    this.scheduleRefresh(0);
  }

  /** Clear staging state — call after a successful commit. */
  clearStaged(): void {
    this.stagedPaths.clear();
    this.persistStaged();
  }

  private persistStaged(): void {
    void this.storage.update(this.storageKey, [...this.stagedPaths]);
  }

  private relPath(uri: vscode.Uri): string {
    return path.relative(this.repo.root, uri.fsPath);
  }

  /**
   * Populate the SCM panel header buttons that sit on the repo row next to
   * the title. Both buttons are visible at all times — the branch pill and
   * an ellipsis that opens the full action quick-pick.
   *
   * `statusBarCommands` is the only API surface for visible buttons here;
   * `scm/sourceControl` menu contributions render only on right-click.
   */
  private updateTitleButtons(): void {
    const id = this.repo.info;
    const branch = id.branchName || '?';
    const paused = id.paused ? ' $(debug-pause)' : '';
    const ro = id.readOnly ? ' $(lock)' : '';
    this.sc.statusBarCommands = [
      {
        command: 'diversion.switchBranch',
        title: `$(git-branch) ${branch}${paused}${ro}`,
        tooltip: [
          `Repo: ${id.repoName}`,
          `Branch: ${branch} (${id.branchId})`,
          `Commit: ${id.commitId}`,
          id.paused ? 'Sync: paused' : 'Sync: active',
          'Click to switch branch',
        ].join('\n'),
      },
      {
        command: 'diversion.moreActions',
        title: '$(ellipsis)',
        tooltip: 'Diversion: more actions',
      },
    ];
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function toResourceState(
  root: string,
  change: FileChange,
  isStaged: boolean,
): vscode.SourceControlResourceState {
  const uri = vscode.Uri.file(path.join(root, change.path));
  // contextValue drives the inline / context-menu when-clauses in package.json
  // and is also read by the discard command to choose between fs.rm (added)
  // and `dv reset -f` (modified/deleted/renamed). Encoding the kind on the
  // unstaged side keeps that branching declarative.
  const contextValue = isStaged ? `staged-${change.kind}` : `unstaged-${change.kind}`;
  return {
    resourceUri: uri,
    decorations: decorationsFor(change.kind),
    contextValue,
    command: {
      command: 'diversion.openResource',
      title: 'Open',
      arguments: [uri, change.kind],
    },
  };
}

function decorationsFor(kind: ChangeKind): vscode.SourceControlResourceDecorations {
  switch (kind) {
    case 'added':
      return { tooltip: 'Added', light: { iconPath: undefined }, dark: { iconPath: undefined } };
    case 'modified':
      return { tooltip: 'Modified' };
    case 'deleted':
      return { tooltip: 'Deleted', strikeThrough: true, faded: true };
    case 'renamed':
      return { tooltip: 'Renamed' };
  }
}

