import * as path from 'node:path';
import { isInsideOrEqual } from '../util/path.js';

/**
 * Validate a path operand before it is spliced into a `dv` argv array.
 *
 * Two protections, both under the "the caller may be an adversarial or
 * confused LLM / MCP client" threat model. The extension's own callers pass
 * dv-sourced, already-safe repo-relative paths and are unaffected.
 *
 *  1. Containment — `path.resolve` collapses any `..` segments and we assert
 *     the result stays inside `root`, so a tool cannot `annotate` / `restore`
 *     / `commit` / `lock` a file outside the workspace (path traversal).
 *  2. Flag neutralization — a path that begins with `-` (e.g. a file literally
 *     named `--clean`) is prefixed with `./` so dv parses it as a path, not a
 *     flag. `spawn` is already shell-free, so option injection is the only
 *     injection class left; this closes it for path operands.
 *
 * Returns the (possibly `./`-prefixed) path to hand to dv. The original
 * separator style is preserved — dv accepts forward slashes everywhere.
 */
export function safeRepoPath(root: string, p: string): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Error('Empty path operand.');
  const resolved = path.resolve(root, trimmed);
  if (!isInsideOrEqual(root, resolved)) {
    throw new Error(`Path escapes the repository root: "${p}"`);
  }
  return trimmed.startsWith('-') ? `./${trimmed}` : trimmed;
}

/**
 * Validate a ref / branch / tag / commit / shelf operand. These are never
 * filesystem paths, so containment does not apply — we only reject a leading
 * `-`, which would otherwise let the value be parsed as a dv flag (argument
 * injection). Empty values are rejected too.
 */
export function safeRef(ref: string, kind = 'ref'): string {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error(`Empty ${kind} operand.`);
  if (trimmed.startsWith('-')) {
    throw new Error(`Refusing ${kind} that looks like a flag: "${ref}"`);
  }
  return trimmed;
}
