import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { isInsideOrEqual, pathEquals } from './path.js';
import type { Logger } from './log.js';

const SKIP_DIR_NAMES = new Set(['.diversion', '.git', 'node_modules']);
const MAX_DIRS = 5000; // safety cap on the recursive scan

/**
 * Per-repo gitignore-style matcher honouring Diversion's ignore files
 * (.dvignore takes precedence over .gitignore at any given directory)
 * with hierarchical inheritance from the repo root downward.
 *
 * Loading is recursive: at activation we walk every directory under the
 * repo root, picking up .dvignore + .gitignore at each level. Each one
 * gets its own `ignore` instance keyed by the absolute directory path it
 * lives in. To answer "is this file ignored?" we walk the file's
 * ancestor directories from leaf to root, asking each level's matcher
 * (using paths relative to that level) and stopping on the first hit.
 *
 * Precedence rule for same-directory conflicts: `gitignore` patterns are
 * added first, then `dvignore` patterns. Because the `ignore` library
 * processes patterns in order and later patterns override earlier ones,
 * a dvignore pattern wins against a same-directory gitignore one — which
 * matches dv's documented "dvignore takes precedence" semantics.
 */
export class IgnoreManager {
  private readonly matchers = new Map<string, ReturnType<typeof ignore>>();
  /**
   * Absolute paths of directories whose entire contents are ignored —
   * either because every file under them matches a pattern or because
   * every subdirectory is itself fully ignored. Lets us gray out a
   * folder in the explorer when it isn't *directly* matched by any
   * .dvignore / .gitignore line but everything inside it is, mirroring
   * git's SCM behaviour.
   */
  private readonly ignoredDirs = new Set<string>();
  private repoRoot: string | undefined;
  private loadInFlight: Promise<void> | undefined;
  private loadQueued = false;

  constructor(private readonly logger: Logger) {}

  /**
   * (Re)load all ignore files under the given repo root. Single-flight: two
   * rapid ignore-file saves must not run two scans that concurrently clear
   * and repopulate the shared maps (which corrupts the matcher state). A
   * queued rerun after the in-flight load picks up the latest on-disk state.
   */
  async load(repoRoot: string): Promise<void> {
    this.repoRoot = repoRoot;
    if (this.loadInFlight) {
      this.loadQueued = true;
      return this.loadInFlight;
    }
    this.loadInFlight = this.doLoad().finally(() => {
      this.loadInFlight = undefined;
      if (this.loadQueued) {
        this.loadQueued = false;
        if (this.repoRoot) void this.load(this.repoRoot);
      }
    });
    return this.loadInFlight;
  }

  private async doLoad(): Promise<void> {
    const repoRoot = this.repoRoot!;
    this.matchers.clear();
    this.ignoredDirs.clear();
    const t0 = Date.now();
    let dirsScanned = 0;
    let hitCap = false;
    await this.scanDir(repoRoot, () => {
      dirsScanned++;
      if (dirsScanned >= MAX_DIRS) { hitCap = true; return false; }
      return true;
    });
    if (hitCap) {
      this.logger.warn(
        `[ignore] scan hit the ${MAX_DIRS}-directory cap under ${repoRoot}; ` +
        `ignore files below that point were not read and those files won't gray out`,
      );
    }
    this.logger.info(
      `[ignore] loaded ${this.matchers.size} ignore file(s) ` +
      `from ${dirsScanned} dir(s) under ${repoRoot} ` +
      `(${this.ignoredDirs.size} fully-ignored dir(s)) ` +
      `(${Date.now() - t0}ms)`,
    );
  }

  /**
   * Returns true if the given absolute path is ignored by any .dvignore /
   * .gitignore at or above its directory (within the repo), or — for
   * directories — if every entry it contains is itself ignored.
   */
  isIgnored(absPath: string): boolean {
    if (!this.repoRoot) return false;
    if (!isInsideOrEqual(this.repoRoot, absPath)) return false;
    if (this.containsSkippedSegment(absPath)) return false;

    if (this.ignoredDirs.has(absPath)) return true;

    let dir = path.dirname(absPath);
    while (true) {
      const matcher = this.matchers.get(dir);
      if (matcher) {
        const rel = path.relative(dir, absPath).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && matcher.ignores(rel)) return true;
      }
      if (pathEquals(dir, this.repoRoot)) break;
      const parent = path.dirname(dir);
      if (pathEquals(parent, dir)) break;
      dir = parent;
    }
    return false;
  }

  /**
   * Reload if the changed path is one of our ignore files. Returns true
   * if the path was relevant, so callers know to fire decoration-change
   * events.
   */
  async maybeReload(absChangedPath: string): Promise<boolean> {
    const base = path.basename(absChangedPath);
    if (base !== '.dvignore' && base !== '.gitignore') return false;
    if (!this.repoRoot || !isInsideOrEqual(this.repoRoot, absChangedPath)) return false;
    await this.load(this.repoRoot);
    return true;
  }

  private containsSkippedSegment(absPath: string): boolean {
    const sep = path.sep;
    for (const skip of SKIP_DIR_NAMES) {
      if (absPath.includes(`${sep}${skip}${sep}`) || absPath.endsWith(`${sep}${skip}`)) return true;
    }
    return false;
  }

  /**
   * Recursively scan `dir`, loading ignore files as we go and computing
   * which directories are "fully ignored" (every entry inside is
   * ignored). Returns true iff `dir` itself is fully ignored.
   *
   * The roll-up has to happen here, in the same pass that loads the
   * matchers, so that by the time we check a file with `isIgnored` its
   * directory and every ancestor's matcher is already in `this.matchers`.
   */
  private async scanDir(dir: string, budget: () => boolean): Promise<boolean> {
    if (!budget()) return false;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    const has = (name: string) => entries.some((e) => e.name === name && e.isFile());
    if (has('.dvignore') || has('.gitignore')) {
      await this.loadDirIgnores(dir);
    }

    // Empty directories don't roll up — git doesn't track them and we
    // don't want a stray empty folder rendering gray for no reason.
    let allIgnored = entries.length > 0;
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        // .git / .diversion / node_modules are effectively ignored
        // from the user's perspective — count them toward the roll-up
        // but never recurse into them.
        continue;
      }
      if (entry.isSymbolicLink()) {
        // We don't follow symlinks, so we can't reason about their
        // contents — be conservative and treat them as not-ignored.
        allIgnored = false;
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const childFullyIgnored = await this.scanDir(child, budget);
        if (!childFullyIgnored) allIgnored = false;
      } else if (entry.isFile()) {
        if (!this.isIgnored(child)) allIgnored = false;
      } else {
        allIgnored = false;
      }
    }

    // Don't ever mark the repo root itself — that would gray the
    // workspace folder in the explorer.
    if (allIgnored && this.repoRoot && !pathEquals(dir, this.repoRoot)) {
      this.ignoredDirs.add(dir);
    }
    return allIgnored;
  }

  private async loadDirIgnores(dir: string): Promise<void> {
    let gitContent = '';
    let dvContent = '';
    try { gitContent = await fs.readFile(path.join(dir, '.gitignore'), 'utf8'); } catch { /* no .gitignore */ }
    try { dvContent = await fs.readFile(path.join(dir, '.dvignore'), 'utf8'); } catch { /* no .dvignore */ }
    if (!gitContent && !dvContent) return;

    const matcher = ignore();
    // gitignore first, then dvignore — the ignore library applies
    // patterns in order and later patterns override earlier ones, so
    // dvignore "takes precedence" on conflicts (e.g. a dvignore
    // negation un-ignoring a gitignore'd file).
    // .gitignore is left strict (the way git itself reads it). Only
    // .dvignore gets the lenient mid-slash rewrite — that's where dv's
    // observed "match anywhere" behaviour shows up.
    if (gitContent) matcher.add(gitContent);
    if (dvContent) matcher.add(unanchorContent(dvContent));
    this.matchers.set(dir, matcher);
  }
}

/**
 * Rewrite .dvignore content so mid-slash patterns match at any depth,
 * matching `dv`'s observed lenient behaviour rather than gitignore's
 * strict "mid-slash means anchored to this file's directory" rule.
 *
 * Concretely: a line like `Binaries/*` is rewritten to `**`+`/Binaries/*`
 * so it ignores `FaunaPrototype/Binaries/...` even when the .dvignore
 * lives a level above. dv silently treats untracked files inside such
 * folders as ignored, so without this our explorer decoration would
 * disagree with `dv status`.
 *
 * Only .dvignore gets this treatment — .gitignore is interpreted
 * strictly (the way git itself reads it), and dv reads .gitignore for
 * compatibility under those same strict rules.
 *
 * Lines we leave untouched:
 *   - blanks and comments
 *   - explicitly anchored patterns (`/foo`, `!/foo`)
 *   - patterns with no internal slash (`*.so`, `Build/`) — the `ignore`
 *     library already matches those at any depth
 */
function unanchorContent(content: string): string {
  return content.split('\n').map(unanchorPattern).join('\n');
}

function unanchorPattern(line: string): string {
  // Preserve trailing CR in CRLF files and any trailing whitespace —
  // the `ignore` library tolerates them and round-tripping keeps line
  // numbers stable for any future debugging.
  const trimmed = line.replace(/\s+$/, '');
  if (!trimmed || trimmed.startsWith('#')) return line;

  let prefix = '';
  let body = trimmed;
  if (body.startsWith('!')) { prefix = '!'; body = body.slice(1); }
  if (body.startsWith('/')) return line; // explicitly anchored — keep as-is

  // Only rewrite when there's a slash *inside* the pattern (not just a
  // trailing one). Patterns like `*.so` or `Build/` already match at any
  // depth under gitignore semantics.
  const withoutTrailingSlash = body.replace(/\/$/, '');
  if (!withoutTrailingSlash.includes('/')) return line;

  return `${prefix}**/${body}`;
}
