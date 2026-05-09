import * as path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Internal: normalise a path for case- and separator-insensitive comparison
 * on Windows. POSIX paths are returned unchanged. Used by {@link pathEquals}
 * and {@link isInsideOrEqual} so the same logic drives both.
 */
function normalizeForCompare(p: string): string {
  if (!IS_WINDOWS) return p;
  // Windows is case-insensitive at the filesystem layer, and dv's daemon
  // sometimes serialises paths with forward slashes while `fs.realpath`
  // returns backslashes — collapse both so equality survives the round-trip.
  return p.replace(/\//g, '\\').toLowerCase();
}

/**
 * Equality check that survives Windows case- and separator-folding.
 * On POSIX it's a strict string compare.
 */
export function pathEquals(a: string, b: string): boolean {
  if (a === b) return true;
  if (!IS_WINDOWS) return false;
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * True iff `candidate` is the same path as `parent` or is contained inside
 * it. Honours Windows case-insensitivity (`C:\Users\...` matches
 * `c:\users\...`) and forward/back-slash mixing.
 *
 * Example (Linux):  isInsideOrEqual('/a/b', '/a/b/c.txt')   → true
 * Example (Windows): isInsideOrEqual('C:\\a\\b', 'c:/a/b/c.txt') → true
 *
 * NOTE: this does NOT canonicalise via realpath — symlinks must be resolved
 * by callers when relevant (we already do this in detect.ts for the daemon
 * registry cross-check).
 */
export function isInsideOrEqual(parent: string, candidate: string): boolean {
  if (pathEquals(parent, candidate)) return true;
  const sep = path.sep;
  const parentSlash = parent.endsWith(sep) ? parent : parent + sep;
  if (candidate.startsWith(parentSlash)) return true;
  if (!IS_WINDOWS) return false;
  // Last-resort: normalised prefix check for the mixed-case-or-mixed-sep
  // scenarios pathEquals already handles for exact equality.
  const np = normalizeForCompare(parentSlash);
  const nc = normalizeForCompare(candidate);
  return nc.startsWith(np);
}

/**
 * Convert a native filesystem path to forward-slash form for handing to `dv`.
 * `dv` accepts both styles on Windows in our testing, but every dv internal
 * representation we've seen (.dvignore patterns, daemon JSON paths, log
 * output) uses forward slashes — so we normalise on the way out. No-op on
 * POSIX systems since `path.sep` is already `/`.
 */
export function toForwardSlashes(p: string): string {
  return path.sep === '/' ? p : p.replace(/\\/g, '/');
}
