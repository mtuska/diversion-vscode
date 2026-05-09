import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runDv } from '../diversion/cli.js';
import { parseUnifiedDiff } from '../diversion/parsers/unifiedDiff.js';
import { reverseApply } from '../diversion/reverseApply.js';
import { looksBinary } from '../util/binary.js';
import type { Logger } from '../util/log.js';

/** URI scheme used for "the contents of <file> at commit <id>". */
export const DV_COMMIT_SCHEME = 'dv-commit';

interface RepoLookup {
  rootForPath(fsPath: string): { root: string; dvPath: string | undefined } | undefined;
}

/**
 * Build a `dv-commit:` URI for the given absolute filesystem path at a
 * specific commit. The scheme + query encoding is:
 *
 *     dv-commit:<absPath>?commit=<commitId>
 *
 * The path part keeps the original fsPath so VS Code's diff editor uses a
 * sensible filename in the tab; the commit ID rides in the query string.
 */
export function commitContentUri(absFsPath: string, commitId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DV_COMMIT_SCHEME,
    path: absFsPath,
    query: `commit=${encodeURIComponent(commitId)}`,
  });
}

/**
 * Resolves `dv-commit:<absPath>?commit=<id>` URIs to the file contents at
 * the named commit. Strategy: read the working-tree contents, ask dv for
 * the unified diff between the requested commit and the workspace, then
 * reverse-apply to recover the at-commit version. Identical mechanism to
 * QuickDiff's "base" lookup, just parameterised over an arbitrary commit.
 *
 * Empty string is returned (rather than `undefined`) for any failure mode
 * so the diff editor renders a well-defined empty side instead of throwing
 * "Invalid arguments".
 */
export class CommitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Cache resolved content per-URI; bust on workspace edit. */
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly lookup: RepoLookup,
    private readonly logger: Logger,
  ) {}

  invalidate(absFsPath: string): void {
    for (const key of [...this.cache.keys()]) {
      const u = vscode.Uri.parse(key);
      if (u.path === absFsPath) {
        this.cache.delete(key);
        this._onDidChange.fire(u);
      }
    }
  }

  invalidateAll(): void {
    for (const key of this.cache.keys()) this._onDidChange.fire(vscode.Uri.parse(key));
    this.cache.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.compute(uri).catch((err) => {
        this.logger.warn(`[dv-commit] resolve failed for ${uri.toString()}: ${(err as Error).message}`);
        return '';
      });
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async compute(uri: vscode.Uri): Promise<string> {
    if (uri.scheme !== DV_COMMIT_SCHEME) return '';
    const params = new URLSearchParams(uri.query);
    const commitId = params.get('commit');
    if (!commitId) return '';

    const fsPath = uri.path;
    const lookup = this.lookup.rootForPath(fsPath);
    if (!lookup) {
      this.logger.warn(`[dv-commit] no repo for ${fsPath}`);
      return '';
    }

    if (await looksBinary(fsPath)) return '';

    let working: string;
    try {
      working = await fs.readFile(fsPath, 'utf8');
    } catch {
      // The file doesn't exist on disk anymore (deleted in some later
      // commit, or this is a path that never existed). We can't reverse-
      // apply without an anchor — return empty.
      return '';
    }

    const relPath = path.relative(lookup.root, fsPath);
    const r = await runDv(
      ['diff', '--color', 'never', '--base', commitId, relPath || fsPath],
      { cwd: lookup.root, dvPath: lookup.dvPath, timeoutMs: 30_000 },
    );
    if (r.exitCode !== 0) {
      this.logger.warn(`[dv-commit] dv diff exited ${r.exitCode} for ${commitId} ${relPath}`);
      return '';
    }

    const stdout = r.stdout;
    const trimmed = stdout.trim();
    if (!trimmed || /^no changes/i.test(trimmed)) {
      // File is identical at <commit> and workspace.
      return working;
    }
    const diff = parseUnifiedDiff(stdout);
    if (diff.binary) return '';

    const at = reverseApply(working, diff);
    return at ?? '';
  }

  dispose(): void { this._onDidChange.dispose(); this.cache.clear(); }
}
