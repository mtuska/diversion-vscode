import * as vscode from 'vscode';
import type { Repo } from '../diversion/repo.js';
import type {
  WorkspaceSyncProgress,
  WorkspaceSyncStatus,
} from '../diversion/types.js';
import type { Logger } from '../util/log.js';

const PROGRESS_POLL_MS = 1500;

/**
 * Single shared status-bar item showing the active workspace's branch
 * and live sync state. Updated by the extension after each SCM refresh;
 * also self-polls AgentAPI `/sync/progress` while a sync is in flight
 * so the user sees real-time bytes / action without needing to refresh.
 *
 * Priority is set very high (1000) so this item lands among the
 * leftmost status-bar slots — alongside the built-in Git branch
 * indicator — even when other extensions compete for space.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /**
   * Active sync-progress poll, scoped to a particular workspace ID.
   * The next `update(...)` clears it; the timer also self-cancels
   * once the workspace reports complete.
   */
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private progressWorkspaceId: string | undefined;

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

  update(active: Repo | undefined, sync?: WorkspaceSyncStatus): void {
    this.stopProgressPolling();

    if (!active) {
      this.logger.debug('[statusBar] no active repo — hiding');
      this.item.hide();
      return;
    }

    this.render(active, sync, undefined);

    // If we know the workspace is syncing, kick off a background poll
    // so the bytes/action fields stay live without waiting for the next
    // SCM refresh. The poll auto-cancels when sync completes.
    const isSyncing = sync ? !sync.IsSyncComplete && !sync.IsPaused : false;
    if (isSyncing) this.startProgressPolling(active);
  }

  /** Render the bar from the latest snapshot of repo + sync state. */
  private render(
    repo: Repo,
    sync: WorkspaceSyncStatus | undefined,
    progress: WorkspaceSyncProgress | undefined,
  ): void {
    const id = repo.info;
    const indicator = syncIndicator(sync, progress);
    const readOnly = id.readOnly ? ' (read-only)' : '';
    const text = `${indicator.icon}$(git-branch) ${id.branchName || '?'}${readOnly}`;
    this.item.text = text;
    this.item.tooltip = [
      `Repo: ${id.repoName}`,
      `Branch: ${id.branchName} (${id.branchId})`,
      `Commit: ${id.commitId}`,
      `Workspace ID: ${id.workspaceId}`,
      `Tier: ${id.tier || '(unknown)'}`,
      `Sync: ${indicator.tooltip}`,
      'Click to switch branch',
    ].join('\n');
    this.item.show();
    this.logger.info(`[statusBar] showing "${text}"`);
  }

  private startProgressPolling(repo: Repo): void {
    this.progressWorkspaceId = repo.info.workspaceId;
    const tick = async (): Promise<void> => {
      if (this.progressWorkspaceId !== repo.info.workspaceId) return;
      const [sync, progress] = await Promise.all([
        repo.syncStatus(),
        repo.syncProgress(),
      ]);
      if (this.progressWorkspaceId !== repo.info.workspaceId) return;
      this.render(repo, sync, progress);
      // Stop once the workspace settles into a complete or paused state.
      if (!sync || sync.IsSyncComplete || sync.IsPaused) {
        this.stopProgressPolling();
        return;
      }
      this.progressTimer = setTimeout(() => void tick(), PROGRESS_POLL_MS);
    };
    this.progressTimer = setTimeout(() => void tick(), PROGRESS_POLL_MS);
  }

  private stopProgressPolling(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.progressWorkspaceId = undefined;
  }

  dispose(): void {
    this.stopProgressPolling();
    this.item.dispose();
  }
}

/**
 * Build the icon + tooltip line for the current sync state. Falls back
 * to a neutral "active" line when the agent is unreachable so the
 * status bar still renders something useful.
 */
function syncIndicator(
  sync: WorkspaceSyncStatus | undefined,
  progress: WorkspaceSyncProgress | undefined,
): { icon: string; tooltip: string } {
  if (sync?.IsPaused) return { icon: '$(debug-pause) ', tooltip: 'paused' };
  if (sync && !sync.IsSyncComplete) {
    const detail = formatProgress(progress);
    return {
      icon: '$(sync~spin) ',
      tooltip: detail ? `syncing — ${detail}` : 'syncing',
    };
  }
  if (sync?.IsSyncComplete) return { icon: '', tooltip: 'up to date' };
  return { icon: '', tooltip: 'active' };
}

function formatProgress(progress: WorkspaceSyncProgress | undefined): string {
  if (!progress) return '';
  const parts: string[] = [];
  if (progress.CurrentSyncAction) parts.push(progress.CurrentSyncAction);
  const inbound = progress.FileStats?.Inbound;
  const outbound = progress.FileStats?.Outbound;
  if (inbound && inbound.ItemsCount > 0) {
    parts.push(`↓ ${inbound.ItemsCount} (${formatBytes(inbound.ProgressStatus)})`);
  }
  if (outbound && outbound.ItemsCount > 0) {
    parts.push(`↑ ${outbound.ItemsCount} (${formatBytes(outbound.ProgressStatus)})`);
  }
  if (progress.LocalEventQueueSize && progress.LocalEventQueueSize > 0) {
    parts.push(`queue ${progress.LocalEventQueueSize}`);
  }
  return parts.join(' · ');
}

function formatBytes(p: { TotalBytes: number; ExpectedTotalBytes: number }): string {
  const expected = p.ExpectedTotalBytes;
  const total = p.TotalBytes;
  if (expected > 0) {
    const pct = Math.min(100, Math.round((total / expected) * 100));
    return `${pct}%`;
  }
  return humanBytes(total);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
