import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repo } from '../diversion/repo.js';
import { formatDay, formatRelative } from '../util/dates.js';
import type { Logger } from '../util/log.js';

interface RepoLookup {
  forUri(uri: vscode.Uri): { repo: Repo; root: string } | undefined;
}

/**
 * Toggleable per-line blame decorations. When enabled, each line of the
 * active editor gets a faint right-aligned annotation showing the commit
 * author and date pulled from `dv annotate`. Re-renders on editor change.
 */
/** Max distinct documents whose blame we keep cached (bounds heap). */
const BLAME_CACHE_CAP = 64;

export class Blame implements vscode.Disposable {
  private enabled = false;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  /** Computed decorations keyed by document URI, valid for one doc version. */
  private readonly cache = new Map<string, { version: number; decorations: vscode.DecorationOptions[] }>();
  /** Monotonic run counter + the latest run per document, so a slow annotate
   *  that resolves after a newer one (save → switch away → back) is dropped
   *  instead of painting stale blame over fresh. */
  private seq = 0;
  private readonly latestSeq = new Map<string, number>();
  /** Per-document cancellation, so rapid tab-cycling cancels superseded spawns. */
  private readonly inFlight = new Map<string, vscode.CancellationTokenSource>();

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
    const key = uri.toString();
    const version = editor.document.version;

    // Serve a cached blame for this exact document version without spawning.
    const cached = this.cache.get(key);
    if (cached && cached.version === version) {
      editor.setDecorations(this.decoration, cached.decorations);
      return;
    }

    const mySeq = ++this.seq;
    this.latestSeq.set(key, mySeq);
    // Cancel any older in-flight annotate for this document.
    this.inFlight.get(key)?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.inFlight.set(key, cts);

    const match = this.lookup.forUri(uri);
    if (!match) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const rel = path.relative(match.root, uri.fsPath);
    let annotations;
    try {
      annotations = await match.repo.annotate(rel, cts.token);
    } catch (err) {
      if (this.latestSeq.get(key) === mySeq) {
        this.logger.warn(`[blame] annotate failed for ${rel}: ${(err as Error).message}`);
        editor.setDecorations(this.decoration, []);
      }
      return;
    } finally {
      if (this.inFlight.get(key) === cts) this.inFlight.delete(key);
      cts.dispose();
    }
    // A newer run for this document superseded us — drop this stale result.
    if (this.latestSeq.get(key) !== mySeq) return;
    // Render the metadata at the END of each contiguous same-commit block
    // (matches GitLens / git-blame conventions). All other lines in the
    // block keep just the hover tooltip.
    const decorations: vscode.DecorationOptions[] = [];
    for (let i = 0; i < annotations.length; i++) {
      const a = annotations[i]!;
      const lineIdx = a.lineNumber - 1;
      if (lineIdx < 0 || lineIdx >= editor.document.lineCount) continue;
      const range = editor.document.lineAt(lineIdx).range;
      const next = annotations[i + 1];
      const isLastOfBlock = !next || next.commitId !== a.commitId;

      const decoration: vscode.DecorationOptions = {
        range,
        hoverMessage: hoverFor(a),
      };
      if (isLastOfBlock) {
        const text = a.uncommitted
          ? '⏵ uncommitted'
          : `⏵ ${a.author ?? '?'}${a.date ? ` · ${formatRelative(a.date)}` : ''}${a.commitId ? ` · ${a.commitId}` : ''}`;
        decoration.renderOptions = { after: { contentText: text } };
      }
      decorations.push(decoration);
    }
    // Cache for this document version, bounding the map size.
    this.cache.set(key, { version, decorations });
    if (this.cache.size > BLAME_CACHE_CAP) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    // Make sure we apply to the same editor that's still active.
    const stillActive = vscode.window.activeTextEditor;
    if (stillActive && stillActive.document === editor.document) {
      stillActive.setDecorations(this.decoration, decorations);
    }
  }

  dispose(): void {
    for (const cts of this.inFlight.values()) cts.cancel();
    this.inFlight.clear();
    this.cache.clear();
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
    if (a.date) md.appendMarkdown(` · ${formatDay(a.date)}`);
    if (a.commitId) md.appendMarkdown(`\n\n\`${a.commitId}\``);
  }
  return md;
}
