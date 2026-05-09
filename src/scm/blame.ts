import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';

interface RepoLookup {
  forUri(uri: vscode.Uri): { repo: Repo; root: string } | undefined;
}

/**
 * Toggleable per-line blame decorations. When enabled, each line of the
 * active editor gets a faint right-aligned annotation showing the commit
 * author and date pulled from `dv annotate`. Re-renders on editor change.
 */
export class Blame implements vscode.Disposable {
  private enabled = false;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly lookup: RepoLookup,
    private readonly logger: Logger,
  ) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      isWholeLine: true,
    });
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (this.enabled && ed) void this.applyTo(ed);
      }),
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (!this.enabled) return;
        const ed = vscode.window.activeTextEditor;
        if (ed?.document === doc) await this.applyTo(ed);
      }),
    );
  }

  async toggle(): Promise<void> {
    this.enabled = !this.enabled;
    const ed = vscode.window.activeTextEditor;
    if (this.enabled && ed) {
      await this.applyTo(ed);
    } else if (ed) {
      ed.setDecorations(this.decoration, []);
    }
  }

  /** Imperative show/hide — used by future inline-blame palette commands. */
  async show(): Promise<void> { if (!this.enabled) await this.toggle(); }
  async hide(): Promise<void> { if (this.enabled) await this.toggle(); }

  private async applyTo(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') return;
    const match = this.lookup.forUri(uri);
    if (!match) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const rel = path.relative(match.root, uri.fsPath);
    let annotations;
    try {
      annotations = await match.repo.annotate(rel);
    } catch (err) {
      this.logger.warn(`[blame] annotate failed for ${rel}: ${(err as Error).message}`);
      editor.setDecorations(this.decoration, []);
      return;
    }
    // Render the metadata only on the first line of each commit block —
    // continuation lines get a hover-only decoration so the editor stays
    // legible. A "block" is a contiguous run of lines that share commit ID.
    const decorations: vscode.DecorationOptions[] = [];
    let prevCommit: string | undefined = '<none>';
    for (const a of annotations) {
      const lineIdx = a.lineNumber - 1;
      if (lineIdx < 0 || lineIdx >= editor.document.lineCount) continue;
      const range = editor.document.lineAt(lineIdx).range;
      const isFirstOfBlock = a.commitId !== prevCommit;
      prevCommit = a.commitId;

      const decoration: vscode.DecorationOptions = {
        range,
        hoverMessage: hoverFor(a),
      };
      if (isFirstOfBlock) {
        const text = a.uncommitted
          ? '⏵ uncommitted'
          : `⏵ ${a.author ?? '?'}${a.date ? ` · ${a.date}` : ''}${a.commitId ? ` · ${a.commitId}` : ''}`;
        decoration.renderOptions = { after: { contentText: text } };
      }
      decorations.push(decoration);
    }
    // Make sure we apply to the same editor that's still active.
    const stillActive = vscode.window.activeTextEditor;
    if (stillActive && stillActive.document === editor.document) {
      stillActive.setDecorations(this.decoration, decorations);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function hoverFor(a: { commitId?: string; author?: string; date?: string; uncommitted: boolean }): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  if (a.uncommitted) {
    md.appendMarkdown('**uncommitted** — line modified locally and not yet committed.');
  } else {
    md.appendMarkdown(`**${a.author ?? 'unknown'}**`);
    if (a.date) md.appendMarkdown(` · ${a.date}`);
    if (a.commitId) md.appendMarkdown(`\n\n\`${a.commitId}\``);
  }
  return md;
}
