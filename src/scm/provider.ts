import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Repo } from '../diversion/repo.js';
import type { FileChange, ChangeKind } from '../diversion/types.js';
import type { Logger } from '../util/log.js';

const PROVIDER_ID = 'diversion';

/**
 * SCM provider for one Diversion workspace. Owns a `vscode.SourceControl`,
 * its resource groups, and the refresh lifecycle.
 */
export class DiversionScmProvider implements vscode.Disposable {
  private readonly sc: vscode.SourceControl;
  private readonly groupChanges: vscode.SourceControlResourceGroup;
  private readonly groupNew: vscode.SourceControlResourceGroup;
  private readonly groupConflicts: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];

  private refreshTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private pendingRefresh = false;

  constructor(
    readonly repo: Repo,
    private readonly logger: Logger,
    quickDiffProvider?: vscode.QuickDiffProvider,
  ) {
    this.sc = vscode.scm.createSourceControl(
      PROVIDER_ID,
      `Diversion · ${repo.info.repoName || path.basename(repo.root)}`,
      vscode.Uri.file(repo.root),
    );
    this.sc.inputBox.placeholder = 'Commit message (Ctrl+Enter to commit)';
    this.sc.acceptInputCommand = {
      command: 'diversion.commit',
      title: 'Commit',
      arguments: [this.sc],
    };

    if (quickDiffProvider) {
      this.sc.quickDiffProvider = quickDiffProvider;
    }

    // Order matters — Conflicts first so the user sees them above other work.
    this.groupConflicts = this.sc.createResourceGroup('conflicts', 'Conflicts');
    this.groupChanges = this.sc.createResourceGroup('changes', 'Changes');
    this.groupNew = this.sc.createResourceGroup('new', 'New');
    this.groupConflicts.hideWhenEmpty = true;
    this.groupChanges.hideWhenEmpty = true;
    this.groupNew.hideWhenEmpty = true;

    this.disposables.push(this.sc, this.groupConflicts, this.groupChanges, this.groupNew);
  }

  get sourceControl(): vscode.SourceControl { return this.sc; }
  get root(): string { return this.repo.root; }

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
      const [state] = await Promise.all([
        this.repo.getState(),
        this.repo.refreshIdentity(),
      ]);
      const modifiedDeleted: vscode.SourceControlResourceState[] = [];
      const added: vscode.SourceControlResourceState[] = [];

      for (const change of state.changes) {
        const rstate = toResourceState(this.repo.root, change);
        if (change.kind === 'added') added.push(rstate);
        else modifiedDeleted.push(rstate);
      }

      const conflicts: vscode.SourceControlResourceState[] = state.conflicts.map((c) => ({
        resourceUri: vscode.Uri.file(c.originalPath),
        decorations: { tooltip: `Sync conflict — local copy at ${c.sidecarPath}` },
        contextValue: 'conflict',
        command: {
          command: 'diversion.resolveConflict',
          title: 'Resolve',
          arguments: [vscode.Uri.file(c.originalPath), vscode.Uri.file(c.sidecarPath)],
        },
      }));

      this.groupConflicts.resourceStates = conflicts;
      this.groupChanges.resourceStates = modifiedDeleted;
      this.groupNew.resourceStates = added;
      this.sc.count = conflicts.length + modifiedDeleted.length + added.length;
      this.updateTitleButtons();
      this.logger.debug(
        `[scm] refresh: ${conflicts.length} conflicts + ${modifiedDeleted.length} changes + ${added.length} new`,
      );
    } catch (err) {
      this.logger.error(`[scm] refresh failed for ${this.repo.root}`, err);
    }
  }

  /**
   * Populate the SCM panel header buttons: branch indicator + sync state.
   * Mirrors the git extension's "branch" pill that lives in the SCM title.
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
): vscode.SourceControlResourceState {
  const uri = vscode.Uri.file(path.join(root, change.path));
  return {
    resourceUri: uri,
    decorations: decorationsFor(change.kind),
    contextValue: change.kind,
    // Route every click through our own command — at click time we stat the
    // path so directories open the explorer, files open the diff/editor.
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

