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
  private repoRoot: string | undefined;

  constructor(private readonly logger: Logger) {}

  /** (Re)load all ignore files under the given repo root. */
  async load(repoRoot: string): Promise<void> {
    this.repoRoot = repoRoot;
    this.matchers.clear();
    const t0 = Date.now();
    let dirsScanned = 0;
    await this.scanDir(repoRoot, () => {
      dirsScanned++;
      return dirsScanned < MAX_DIRS;
    });
    this.logger.info(
      `[ignore] loaded ${this.matchers.size} ignore file(s) ` +
      `from ${dirsScanned} dir(s) under ${repoRoot} (${Date.now() - t0}ms)`,
    );
  }

  /**
   * Returns true if the given absolute path is ignored by any .dvignore /
   * .gitignore at or above its directory (within the repo).
   */
  isIgnored(absPath: string): boolean {
    if (!this.repoRoot) return false;
    if (!isInsideOrEqual(this.repoRoot, absPath)) return false;
    if (this.containsSkippedSegment(absPath)) return false;

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

  private async scanDir(dir: string, budget: () => boolean): Promise<void> {
    if (!budget()) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const has = (name: string) => entries.some((e) => e.name === name && e.isFile());
    if (has('.dvignore') || has('.gitignore')) {
      await this.loadDirIgnores(dir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // Skip symlinked directories — they could loop and we don't follow
      // symlinks anywhere else in the extension either.
      if (entry.isSymbolicLink()) continue;
      await this.scanDir(path.join(dir, entry.name), budget);
    }
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
    if (gitContent) matcher.add(gitContent);
    if (dvContent) matcher.add(dvContent);
    this.matchers.set(dir, matcher);
  }
}
