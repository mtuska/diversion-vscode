import * as vscode from 'vscode';
import type { ChangeKind } from '../diversion/types.js';
import type { IgnoreManager } from '../util/ignore.js';
import { isInsideOrEqual } from '../util/path.js';
import type { Logger } from '../util/log.js';

/**
 * FileDecorationProvider that colours / badges files according to their
 * current SCM change state. Decorations show in BOTH the SCM panel and the
 * file Explorer, so users can see at a glance what's modified without
 * needing the SCM panel open — same affordance the built-in git extension
 * provides.
 *
 * Letter badges follow the git convention:
 *   - M = Modified
 *   - A = Added
 *   - D = Deleted
 *   - R = Renamed
 *
 * Colours use the `gitDecoration.*` theme tokens so we match the user's
 * existing colour palette regardless of theme. Re-using git's tokens (vs.
 * inventing our own) means a custom theme that styles git decorations
 * automatically styles ours.
 */
export class ChangeDecorationsProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** Map of absolute fs path → change kind, scoped per repo root. */
  private byRepo = new Map<string, Map<string, ChangeKind>>();
  /** Ignore matchers, scoped per repo root. */
  private ignoresByRepo = new Map<string, IgnoreManager>();

  constructor(private readonly logger: Logger) {}

  attachIgnoreManager(repoRoot: string, mgr: IgnoreManager): void {
    this.ignoresByRepo.set(repoRoot, mgr);
    // Force a refresh of every URI we currently know about, plus
    // notify VS Code that any other URI under this repo may have
    // changed. Callers typically follow up with a fire on a broader
    // set; passing undefined invalidates everything as a fallback.
    this._onDidChange.fire(undefined);
  }

  detachIgnoreManager(repoRoot: string): void {
    if (this.ignoresByRepo.delete(repoRoot)) this._onDidChange.fire(undefined);
  }

  /** Re-fire decorations for everything; called after an ignore reload. */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  /**
   * Replace this repo's decoration state. Fires `onDidChangeFileDecorations`
   * for every URI whose decoration changed (added, removed, or kind-changed).
   */
  setRepoState(repoRoot: string, next: Map<string, ChangeKind>): void {
    const previous = this.byRepo.get(repoRoot) ?? new Map<string, ChangeKind>();
    const changed: vscode.Uri[] = [];

    for (const [absPath, kind] of next) {
      if (previous.get(absPath) !== kind) changed.push(vscode.Uri.file(absPath));
    }
    for (const absPath of previous.keys()) {
      if (!next.has(absPath)) changed.push(vscode.Uri.file(absPath));
    }
    this.byRepo.set(repoRoot, next);

    if (changed.length > 0) {
      this.logger.debug(`[changeDecorations] ${changed.length} URIs changed`);
      this._onDidChange.fire(changed);
    }
  }

  /** The current change kind for an absolute filesystem path, if any. */
  kindForPath(fsPath: string): ChangeKind | undefined {
    for (const map of this.byRepo.values()) {
      const kind = map.get(fsPath);
      if (kind) return kind;
    }
    return undefined;
  }

  /** Drop a repo's state entirely (provider unregister). */
  clearRepoState(repoRoot: string): void {
    const previous = this.byRepo.get(repoRoot);
    if (!previous) return;
    const uris = [...previous.keys()].map((p) => vscode.Uri.file(p));
    this.byRepo.delete(repoRoot);
    if (uris.length > 0) this._onDidChange.fire(uris);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    // Tracked changes win over "ignored": once a file has been added /
    // modified / etc. dv treats it as part of the change set even if a
    // later .dvignore pattern would have matched it.
    for (const map of this.byRepo.values()) {
      const kind = map.get(uri.fsPath);
      if (kind) return decorationFor(kind);
    }
    // Otherwise, gray-out files that any matching repo's ignore set covers.
    for (const [root, mgr] of this.ignoresByRepo) {
      if (!isInsideOrEqual(root, uri.fsPath)) continue;
      if (mgr.isIgnored(uri.fsPath)) return ignoredDecoration();
    }
    return undefined;
  }

  dispose(): void { this._onDidChange.dispose(); }
}

function ignoredDecoration(): vscode.FileDecoration {
  return {
    color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
    tooltip: 'Ignored (.dvignore / .gitignore)',
    // Don't propagate — we don't want every parent folder of an ignored
    // file to render gray; only the file itself.
    propagate: false,
  };
}

function decorationFor(kind: ChangeKind): vscode.FileDecoration {
  switch (kind) {
    case 'added':
      return {
        badge: 'A',
        color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
        tooltip: 'Added',
        propagate: true,
      };
    case 'modified':
      return {
        badge: 'M',
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
        tooltip: 'Modified',
        propagate: true,
      };
    case 'deleted':
      return {
        badge: 'D',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        tooltip: 'Deleted',
        propagate: true,
      };
    case 'renamed':
      return {
        badge: 'R',
        color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
        tooltip: 'Renamed',
        propagate: true,
      };
  }
}
