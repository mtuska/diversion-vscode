import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runDvOrThrow } from '../diversion/cli.js';
import { parseUnifiedDiff } from '../diversion/parsers/unifiedDiff.js';
import { reverseApply } from '../diversion/reverseApply.js';
import { looksBinary } from '../util/binary.js';
import type { Logger } from '../util/log.js';

/** URI scheme used for "the base content of <path>". */
export const DV_SCHEME = 'dv-base';

interface RepoLookup {
  rootForPath(fsPath: string): { root: string; dvPath: string | undefined } | undefined;
}

async function realpathOrSelf(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return p; }
}

/**
 * Compute a workspace-relative path that works for `dv` regardless of which
 * symlink form (`/home/...` vs `/var/home/...`) the caller used. If the
 * straightforward `path.relative` ends up traversing upward, we retry against
 * canonicalized roots.
 */
async function workspaceRelative(root: string, target: string): Promise<string> {
  const direct = path.relative(root, target);
  if (direct && !direct.startsWith('..')) return direct;
  const canonRoot = await realpathOrSelf(root);
  const canonTarget = await realpathOrSelf(target);
  const fromCanon = path.relative(canonRoot, canonTarget);
  if (fromCanon && !fromCanon.startsWith('..')) return fromCanon;
  // Last resort: hand back the canonical absolute path. Better than the
  // symlinked one because at least dv resolves it correctly.
  return canonTarget;
}

/**
 * QuickDiffProvider + TextDocumentContentProvider that surface the base
 * (last-committed) version of a file by reverse-applying `dv diff <path>`
 * against the working file's current content.
 *
 * If the diff is binary or doesn't apply cleanly (e.g. the working tree was
 * modified while the diff was being computed), we fall through to the
 * working content — VS Code shows "no differences" rather than crashing.
 */
export class QuickDiff implements vscode.QuickDiffProvider, vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly lookup: RepoLookup,
    private readonly logger: Logger,
  ) {}

  /** Notify VS Code that base content for these files may have changed. */
  invalidateAll(roots: Iterable<string>): void {
    // We don't track every open document; refire on the URI form so VS Code
    // re-fetches when the resource is requested. A single fire is enough — we
    // map by the original working URI.
    for (const root of roots) {
      this._onDidChange.fire(vscode.Uri.file(root).with({ scheme: DV_SCHEME }));
    }
  }

  // QuickDiffProvider: return the URI of the "original" (base) version.
  provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    if (uri.scheme !== 'file') return undefined;
    if (!this.lookup.rootForPath(uri.fsPath)) return undefined;
    return uri.with({ scheme: DV_SCHEME });
  }

  // TextDocumentContentProvider: produce the base contents for a dv-base URI.
  // Always returns a string — VS Code surfaces "Unable to resolve text model
  // content" if we ever return undefined or reject. Worst-case empty.
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      return await this._doProvide(uri);
    } catch (err) {
      this.logger.error(
        `QuickDiff: unhandled error for ${uri.toString()} — returning empty`,
        err,
      );
      return '';
    }
  }

  private async _doProvide(uri: vscode.Uri): Promise<string> {
    this.logger.info(`[QuickDiff] provideTextDocumentContent ${uri.toString()}`);
    if (uri.scheme !== DV_SCHEME) return '';

    let lookup = this.lookup.rootForPath(uri.fsPath);
    if (!lookup) {
      // Try once more with the canonical path, in case a symlink discrepancy
      // (/home vs /var/home) is at play.
      const canon = await realpathOrSelf(uri.fsPath);
      if (canon !== uri.fsPath) lookup = this.lookup.rootForPath(canon);
    }
    if (!lookup) {
      this.logger.warn(`QuickDiff: no repo registered for ${uri.fsPath}`);
      return '';
    }

    // Bail early on binary — dv's diff output for binary is just a marker
    // and reverseApply has nothing to do.
    if (await looksBinary(uri.fsPath)) {
      this.logger.debug(`QuickDiff: ${uri.fsPath} is binary, returning empty base`);
      return '';
    }

    let working = '';
    try {
      working = await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      // File deleted or new — empty base.
      return '';
    }

    // Always pass dv a workspace-relative path. Absolute paths that traverse
    // a symlink (/home → /var/home on Fedora Atomic) cause dv to silently
    // report "No changes detected" — verified against dv v0.9.895 by spawning
    // the same command both ways. Relative paths sidestep the issue and are
    // also what dv likely intends as the canonical form.
    const relPath = await workspaceRelative(lookup.root, uri.fsPath);
    let stdout = '';
    try {
      const r = await runDvOrThrow(
        ['diff', '--color', 'never', relPath],
        { cwd: lookup.root, dvPath: lookup.dvPath, timeoutMs: 30_000 },
      );
      stdout = r.stdout;
    } catch (err) {
      this.logger.warn(
        `QuickDiff: dv diff failed for ${uri.fsPath} (relPath=${relPath}): ${(err as Error).message}`,
      );
      return working;
    }

    const trimmed = stdout.trim();
    if (!trimmed || /^no changes/i.test(trimmed)) {
      this.logger.info(`[QuickDiff] dv reports no changes — returning working as base (will appear identical)`);
      return working;
    }

    const diff = parseUnifiedDiff(stdout);
    if (diff.binary) {
      this.logger.info(`[QuickDiff] diff marker says binary — returning working`);
      return working;
    }
    if (diff.hunks.length === 0) {
      this.logger.warn(
        `[QuickDiff] parseUnifiedDiff produced 0 hunks for ${uri.fsPath}; ` +
        `output preview: ${stdout.slice(0, 200).replace(/\n/g, '\\n')}`,
      );
      return working;
    }

    const base = reverseApply(working, diff);
    if (!base) {
      this.diagnoseReverseApplyFailure(uri.fsPath, working, stdout, diff);
      return working;
    }
    this.logger.info(`[QuickDiff] reverseApply OK — base differs from working: ${base !== working}`);
    return base;
  }

  /**
   * Log enough about a reverseApply failure to figure out which context line
   * mismatched. Triggered when reverse-applying produces undefined.
   */
  private diagnoseReverseApplyFailure(
    fsPath: string,
    working: string,
    stdout: string,
    diff: { hunks: { newStart: number; newCount: number; lines: string[] }[] },
  ): void {
    const workingLines = working.split(/\r?\n/);
    if (working.endsWith('\n')) workingLines.pop();
    const lines: string[] = [
      `QuickDiff: reverseApply failed for ${fsPath}`,
      `  working has ${workingLines.length} line(s); diff has ${diff.hunks.length} hunk(s)`,
      `  raw diff length: ${stdout.length} bytes`,
    ];
    for (const hunk of diff.hunks) {
      const startIdx = hunk.newStart - 1;
      const expected: string[] = [];
      for (const l of hunk.lines) {
        if (l.startsWith(' ') || l.startsWith('+')) expected.push(l.slice(1));
      }
      lines.push(`  hunk @${hunk.newStart},${hunk.newCount} expects ${expected.length} lines`);
      for (let i = 0; i < expected.length; i++) {
        const got = workingLines[startIdx + i];
        if (got !== expected[i]) {
          lines.push(
            `    ↳ first mismatch at line ${startIdx + i + 1}:`,
            `      expected: ${JSON.stringify(expected[i] ?? '')}`,
            `      got:      ${JSON.stringify(got ?? '<EOF>')}`,
          );
          break;
        }
      }
    }
    this.logger.warn(lines.join('\n'));
  }

  dispose(): void { this._onDidChange.dispose(); }
}
