import * as path from 'node:path';

/**
 * True iff `candidate` is the same path as `parent` or is contained inside it.
 * Uses the platform's path separator so this works on both POSIX and Windows.
 *
 * Example (Linux):  isInsideOrEqual('/a/b', '/a/b/c.txt')   → true
 * Example (Windows): isInsideOrEqual('C:\\a\\b', 'C:\\a\\b\\c.txt') → true
 *
 * NOTE: this does NOT canonicalise via realpath — symlinks must be resolved
 * by callers when relevant (we already do this in detect.ts for the daemon
 * registry cross-check).
 */
export function isInsideOrEqual(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const sep = path.sep;
  return candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep);
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
