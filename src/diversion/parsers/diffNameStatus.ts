import type { ChangeKind, FileChange } from '../types.js';

const KIND_MAP: Record<string, ChangeKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
};

const NO_CHANGES_PATTERNS = [
  /^no changes detected/i,
  /^no differences/i,
];

/**
 * Parse the output of `dv diff --name-status`.
 *
 * Each line is `<A|M|D|R>\t<path>` (and for renames, observed format may add
 * an additional column — handled defensively). We have not yet captured a
 * real rename fixture; the renamed-from is parsed if present but otherwise
 * undefined. Update the parser when a real rename fixture is captured.
 */
export function parseDiffNameStatus(stdout: string): FileChange[] {
  const out: FileChange[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    if (NO_CHANGES_PATTERNS.some((p) => p.test(line))) continue;

    // Expected: kind\tpath  (rename may add a second tab and another path)
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const kindRaw = parts[0]!;
    const kind = KIND_MAP[kindRaw[0] ?? ''];
    if (!kind) continue;

    if (kind === 'renamed' && parts.length >= 3) {
      out.push({ kind, fromPath: parts[1]!, path: parts[2]! });
    } else {
      out.push({ kind, path: parts[1]! });
    }
  }
  return out;
}
