import * as vscode from 'vscode';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';

/**
 * Single shared status-bar item showing the active workspace's branch.
 * Updated by the extension after each refresh; clicking it runs
 * `diversion.switchBranch`.
 *
 * Priority is set very high (1000) so this item lands among the leftmost
 * status-bar slots — alongside the built-in Git branch indicator — even when
 * other extensions are competing for space.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly logger: Logger) {
    this.item = vscode.window.createStatusBarItem(
      'diversion.statusBar',
      vscode.StatusBarAlignment.Left,
      1000,
    );
    this.item.name = 'Diversion';
    this.item.command = 'diversion.switchBranch';
    this.item.tooltip = 'Click to switch Diversion branch';
  }

  update(active: Repo | undefined): void {
    if (!active) {
      this.logger.debug('[statusBar] no active repo — hiding');
      this.item.hide();
      return;
    }
    const id = active.info;
    const paused = id.paused ? '$(debug-pause) ' : '';
    const readOnly = id.readOnly ? ' (read-only)' : '';
    const text = `${paused}$(git-branch) ${id.branchName || '?'}${readOnly}`;
    this.item.text = text;
    this.item.tooltip = [
      `Repo: ${id.repoName}`,
      `Branch: ${id.branchName} (${id.branchId})`,
      `Commit: ${id.commitId}`,
      `Workspace ID: ${id.workspaceId}`,
      `Tier: ${id.tier || '(unknown)'}`,
      id.paused ? 'Sync: paused' : 'Sync: active',
      'Click to switch branch',
    ].join('\n');
    this.item.show();
    this.logger.info(`[statusBar] showing "${text}"`);
  }

  dispose(): void { this.item.dispose(); }
}
