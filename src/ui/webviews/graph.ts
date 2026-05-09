import * as vscode from 'vscode';
import type { Repo } from '../../diversion/repo.js';
import type { CommitDetails } from '../../diversion/parsers/log.js';
import type { BranchInfo } from '../../diversion/parsers/branch.js';
import type { Logger } from '../../util/log.js';

export interface GraphInputs {
  commits: CommitDetails[];
  branches: BranchInfo[];
  currentCommitId: string;
  currentBranchName: string;
}

type MessageFromWebview =
  | { kind: 'fetchFiles'; commitId: string }
  | { kind: 'cherryPick'; commitId: string }
  | { kind: 'revert'; commitId: string }
  | { kind: 'revertTo'; commitId: string }
  | { kind: 'openCommitInWeb'; commitId: string };

/**
 * Single-pane interactive history view. Vertical commit timeline on the left
 * with dots and connecting lines; commit cards on the right with author,
 * message, branch refs, and action buttons (Cherry-pick / Revert /
 * Restore To). Each commit can expand to show its file changes.
 *
 * Not a true multi-lane DAG — that's a v0.4 task. For now we draw the
 * branch-tip refs alongside the commits they point at, which covers the
 * common "where did this branch come from" question.
 */
export class GraphWebview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repo: Repo,
    private readonly logger: Logger,
  ) {}

  async show(): Promise<void> {
    const inputs = await this.collectInputs();
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'diversion.graph',
        `Diversion Graph · ${this.repo.info.repoName}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m), undefined, this.disposables);
    }
    this.panel.reveal(undefined, false);
    this.panel.webview.html = renderHtml(inputs);
  }

  /** Re-render after a commit/branch operation. */
  async refresh(): Promise<void> {
    if (!this.panel) return;
    const inputs = await this.collectInputs();
    this.panel.webview.html = renderHtml(inputs);
  }

  private async collectInputs(): Promise<GraphInputs> {
    const [commits, branches] = await Promise.all([
      this.repo.logFull(100),
      this.repo.listBranches(),
    ]);
    return {
      commits,
      branches,
      currentCommitId: this.repo.info.commitId,
      currentBranchName: this.repo.info.branchName,
    };
  }

  private async handleMessage(m: MessageFromWebview): Promise<void> {
    if (!m || typeof m !== 'object' || !('kind' in m)) return;
    switch (m.kind) {
      case 'fetchFiles': {
        try {
          const files = await this.repo.fileChangesForCommit(m.commitId);
          this.panel?.webview.postMessage({ kind: 'files', commitId: m.commitId, files });
        } catch (err) {
          this.logger.warn(`[graph] file changes for ${m.commitId} failed: ${(err as Error).message}`);
          this.panel?.webview.postMessage({ kind: 'files', commitId: m.commitId, files: [], error: (err as Error).message });
        }
        return;
      }
      case 'cherryPick':
        await vscode.commands.executeCommand('diversion.cherryPickCommit', m.commitId);
        await this.refresh();
        return;
      case 'revert':
        await vscode.commands.executeCommand('diversion.revertCommit', m.commitId);
        await this.refresh();
        return;
      case 'revertTo':
        await vscode.commands.executeCommand('diversion.revertToCommit', m.commitId);
        await this.refresh();
        return;
      case 'openCommitInWeb':
        await vscode.commands.executeCommand('diversion.openInWeb');
        return;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function renderHtml(inputs: GraphInputs): string {
  const branchByCommit = new Map<string, BranchInfo[]>();
  for (const b of inputs.branches) {
    const arr = branchByCommit.get(b.commitId) ?? [];
    arr.push(b);
    branchByCommit.set(b.commitId, arr);
  }

  const rows = inputs.commits.map((c, i) => {
    const refs = branchByCommit.get(c.id) ?? [];
    const refPills = refs.map((r) =>
      `<span class="ref ${r.name === inputs.currentBranchName ? 'current' : ''}">${esc(r.name)}</span>`
    ).join('');
    const isHead = c.id === inputs.currentCommitId;
    const subject = c.message.split('\n', 1)[0] ?? '';
    const body = c.message.includes('\n') ? c.message.slice(subject.length).trim() : '';
    return `
    <li class="commit ${isHead ? 'head' : ''} ${c.merge ? 'merge' : ''}">
      <div class="lane">
        <div class="dot"></div>
        ${i < inputs.commits.length - 1 ? '<div class="line"></div>' : ''}
      </div>
      <div class="card">
        <header>
          <span class="subject">${esc(subject)}</span>
          ${refPills}
          ${isHead ? '<span class="ref head-mark">HEAD</span>' : ''}
        </header>
        <div class="meta">
          <span class="author">${esc(c.authorName)}</span>
          <span class="dim">${esc(c.date)}</span>
          <code>${esc(c.id)}</code>
          ${c.merge ? `<span class="merge-tag">merge ← ${esc(c.merge.refName)}</span>` : ''}
        </div>
        ${body ? `<pre class="body">${esc(body)}</pre>` : ''}
        <div class="actions">
          <button data-action="toggleFiles" data-commit="${esc(c.id)}">Show files</button>
          <button data-action="cherryPick" data-commit="${esc(c.id)}">Cherry-pick</button>
          <button data-action="revert" data-commit="${esc(c.id)}">Revert</button>
          <button data-action="revertTo" data-commit="${esc(c.id)}">Restore to…</button>
        </div>
        <div class="files" id="files-${esc(c.id)}" hidden></div>
      </div>
    </li>`;
  }).join('\n');

  // The script lives below as a template literal. Don't reference the user's
  // strings inside the script (XSS); we drive everything via data attributes.
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 0.5rem 1rem; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.05rem; margin: 0.25rem 0 1rem; }
  ul.timeline { list-style: none; padding: 0; margin: 0; }
  li.commit { display: flex; gap: 0.6rem; align-items: stretch; padding: 0.25rem 0; }
  .lane { position: relative; width: 1.4rem; flex: 0 0 1.4rem; display: flex; justify-content: center; }
  .dot { position: absolute; top: 0.45rem; width: 0.7rem; height: 0.7rem; border-radius: 50%; background: var(--vscode-textLink-foreground); box-shadow: 0 0 0 2px var(--vscode-editor-background); z-index: 1; }
  li.commit.head .dot { background: var(--vscode-charts-yellow); width: 0.85rem; height: 0.85rem; top: 0.4rem; }
  li.commit.merge .dot { background: var(--vscode-gitDecoration-modifiedResourceForeground); transform: rotate(45deg); border-radius: 1px; }
  .line { position: absolute; top: 1.05rem; bottom: -0.5rem; width: 2px; background: var(--vscode-tab-border, var(--vscode-textLink-foreground)); opacity: 0.4; }
  .card { flex: 1; padding: 0.35rem 0.6rem 0.5rem; border-left: 2px solid transparent; }
  li.commit.head .card { border-left-color: var(--vscode-charts-yellow); }
  header { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
  .subject { font-weight: 600; }
  .ref { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 999px; font-size: 0.7rem; padding: 0.05rem 0.45rem; line-height: 1.4; }
  .ref.current { background: var(--vscode-textLink-foreground); color: var(--vscode-button-foreground, var(--vscode-editor-background)); }
  .ref.head-mark { background: var(--vscode-charts-yellow); color: var(--vscode-editor-background); }
  .meta { font-size: 0.78rem; display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.1rem 0 0.2rem; }
  .meta code { background: var(--vscode-textCodeBlock-background); padding: 0 0.3rem; border-radius: 3px; font-size: 0.75rem; }
  .dim { color: var(--vscode-descriptionForeground); }
  .merge-tag { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .body { white-space: pre-wrap; margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
  .actions { display: flex; gap: 0.25rem; flex-wrap: wrap; margin-top: 0.3rem; }
  .actions button { font: inherit; font-size: 0.75rem; padding: 0.1rem 0.55rem; cursor: pointer; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-tab-border, var(--vscode-foreground)); border-radius: 3px; }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .files { font-size: 0.78rem; margin-top: 0.35rem; }
  .files .row { display: grid; grid-template-columns: 1.5rem 1fr; gap: 0.25rem; padding: 0.05rem 0; }
  .files .kind { font-weight: 600; text-align: center; }
  .files .kind.M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .files .kind.A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .files .kind.D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .files .kind.R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
</style>
</head>
<body>
<h1>${esc(inputs.commits.length.toString())} commit(s) on ${esc(inputs.currentBranchName)} (${esc(inputs.currentCommitId)})</h1>
<ul class="timeline">${rows}</ul>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const KIND_INITIAL = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const commitId = btn.dataset.commit;
    if (action === 'toggleFiles') {
      const target = document.getElementById('files-' + commitId);
      if (!target) return;
      if (target.hidden) {
        target.hidden = false;
        if (!target.dataset.loaded) {
          target.innerHTML = '<div class="dim">Loading…</div>';
          vscode.postMessage({ kind: 'fetchFiles', commitId });
        }
        btn.textContent = 'Hide files';
      } else {
        target.hidden = true;
        btn.textContent = 'Show files';
      }
      return;
    }
    if (action === 'cherryPick' || action === 'revert' || action === 'revertTo') {
      vscode.postMessage({ kind: action, commitId });
    }
  });
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.kind === 'files') {
      const target = document.getElementById('files-' + msg.commitId);
      if (!target) return;
      target.dataset.loaded = '1';
      if (msg.error) {
        target.innerHTML = '<div class="dim">Error: ' + (msg.error || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div>';
        return;
      }
      if (!msg.files || msg.files.length === 0) {
        target.innerHTML = '<div class="dim">(no file changes)</div>';
        return;
      }
      const html = msg.files.map(f => {
        const kind = KIND_INITIAL[f.kind] || '?';
        const path = (f.path || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        return '<div class="row"><span class="kind ' + kind + '">' + kind + '</span><span>' + path + '</span></div>';
      }).join('');
      target.innerHTML = html;
    }
  });
}());
</script>
</body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
