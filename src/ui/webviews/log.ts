import * as vscode from 'vscode';
import type { CommitDetails } from '../../diversion/types.js';
import { formatDateTime } from '../../util/dates.js';

export function showLogWebview(repoName: string, commits: CommitDetails[]): void {
  const panel = vscode.window.createWebviewPanel(
    'diversion.log',
    `Diversion: ${repoName} history`,
    vscode.ViewColumn.Active,
    { enableScripts: false },
  );
  panel.webview.html = renderHtml(repoName, commits);
}

function renderHtml(repoName: string, commits: CommitDetails[]): string {
  const items = commits.map((c) => `
    <li>
      <header>
        <code>${escape(c.id)}</code>
        ${c.refs.length ? `<span class="refs">${c.refs.map(escape).join(', ')}</span>` : ''}
      </header>
      <div class="meta">
        <span>${escape(c.authorName)}</span>
        <span class="dim">&lt;${escape(c.authorEmail)}&gt;</span>
        <span class="dim">${escape(formatDateTime(c.date))}</span>
        ${c.merge ? `<span class="merge">merge ${escape(c.merge.refName)} ${escape(c.merge.commitId)}</span>` : ''}
      </div>
      <pre>${escape(c.message)}</pre>
    </li>
  `).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); padding: 1rem; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-left: 2px solid var(--vscode-textLink-foreground); padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; }
  header { display: flex; gap: 0.5rem; align-items: baseline; }
  header code { background: var(--vscode-textCodeBlock-background); padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
  .refs { color: var(--vscode-textLink-foreground); font-size: 0.85rem; }
  .meta { font-size: 0.8rem; margin: 0.2rem 0 0.4rem; display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .dim { color: var(--vscode-descriptionForeground); }
  .merge { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  pre { white-space: pre-wrap; margin: 0; font-family: var(--vscode-editor-font-family); font-size: 0.9rem; }
</style></head>
<body>
<h1>${escape(repoName)} — ${commits.length} commit(s)</h1>
<ul>${items}</ul>
</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
