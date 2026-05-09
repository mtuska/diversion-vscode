import type { DiffHunk, ParsedUnifiedDiff } from './parsers/unifiedDiff.js';

/**
 * Given the working-tree contents and a parsed unified diff describing the
 * changes that took it from `base` to `working`, reconstruct `base`.
 *
 * Returns undefined if the diff is binary or if the hunks don't apply
 * cleanly (line-count mismatch, missing context). Callers should then fall
 * back to a different mechanism (e.g. `dv restore` to a temp file) or skip
 * QuickDiff for that file.
 */
export function reverseApply(working: string, diff: ParsedUnifiedDiff): string | undefined {
  if (diff.binary) return undefined;
  if (diff.hunks.length === 0) return working;

  const newline = working.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = working.endsWith(newline);
  const workingLines = working.split(/\r?\n/);
  if (hadTrailingNewline) workingLines.pop(); // discard the empty trailing element

  // Reverse each hunk: replace the working slice with the base slice.
  // Apply in reverse order so earlier indices stay valid.
  const sorted = [...diff.hunks].sort((a, b) => b.newStart - a.newStart);
  let result = workingLines;
  for (const hunk of sorted) {
    const applied = applyHunkReverse(result, hunk);
    if (!applied) return undefined;
    result = applied;
  }

  return result.join(newline) + (hadTrailingNewline ? newline : '');
}

function applyHunkReverse(
  workingLines: readonly string[],
  hunk: DiffHunk,
): string[] | undefined {
  // Validate: the working slice should contain exactly the context+'+' lines.
  const startIdx = hunk.newStart - 1;
  const expectedNewSlice: string[] = [];
  const baseSlice: string[] = [];
  for (const l of hunk.lines) {
    const marker = l[0];
    const body = l.slice(1);
    if (marker === ' ') {
      expectedNewSlice.push(body);
      baseSlice.push(body);
    } else if (marker === '+') {
      expectedNewSlice.push(body);
    } else if (marker === '-') {
      baseSlice.push(body);
    }
  }

  if (startIdx < 0) return undefined;
  if (startIdx + expectedNewSlice.length > workingLines.length) return undefined;
  for (let i = 0; i < expectedNewSlice.length; i++) {
    if (workingLines[startIdx + i] !== expectedNewSlice[i]) return undefined;
  }

  const out = workingLines.slice(0, startIdx)
    .concat(baseSlice)
    .concat(workingLines.slice(startIdx + expectedNewSlice.length));
  return out;
}
