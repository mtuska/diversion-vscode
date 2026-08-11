/**
 * Minimal unified-diff parser. Handles the subset of GNU diff output that
 * `dv diff` produces — `diff --git` header optional, then `---`/`+++`
 * file lines, then `@@ -a,b +c,d @@` hunks.
 *
 * Binary-marker output ("Binary files X and Y differ") is detected and
 * surfaced via `binary: true` so callers can fall back gracefully.
 */

export interface DiffHunk {
  /** 1-based starting line in the base file. */
  baseStart: number;
  baseCount: number;
  /** 1-based starting line in the new file. */
  newStart: number;
  newCount: number;
  /** Each entry preserves its leading marker (' ', '-', '+'). */
  lines: string[];
}

export interface ParsedUnifiedDiff {
  /** Path on the "a" side (base). May be missing for new files. */
  basePath?: string;
  /** Path on the "b" side (working). May be missing for deletes. */
  newPath?: string;
  /** True if the diff is a "Binary files differ" marker. */
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseUnifiedDiff(stdout: string): ParsedUnifiedDiff {
  const result: ParsedUnifiedDiff = { binary: false, hunks: [] };
  if (!stdout.trim()) return result;

  const lines = stdout.split(/\r?\n/);
  let i = 0;
  let currentHunk: DiffHunk | undefined;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('Binary files') && line.includes('differ')) {
      result.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      result.basePath = stripFilePrefix(line.slice(4));
      currentHunk = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      result.newPath = stripFilePrefix(line.slice(4));
      currentHunk = undefined;
      continue;
    }
    const hh = HUNK_HEADER.exec(line);
    if (hh) {
      currentHunk = {
        baseStart: Number.parseInt(hh[1]!, 10),
        baseCount: hh[2] !== undefined ? Number.parseInt(hh[2], 10) : 1,
        newStart: Number.parseInt(hh[3]!, 10),
        newCount: hh[4] !== undefined ? Number.parseInt(hh[4], 10) : 1,
        lines: [],
      };
      result.hunks.push(currentHunk);
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('new file ') || line.startsWith('deleted file ')) {
      currentHunk = undefined;
      continue;
    }
    if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      // '\' line is "\ No newline at end of file" — skip; we don't track that flag.
      if (!line.startsWith('\\')) currentHunk.lines.push(line);
    }
  }

  return result;
}

function stripFilePrefix(p: string): string {
  // diff produces "a/<path>" / "b/<path>" / "/dev/null"
  const trimmed = p.trim();
  if (trimmed === '/dev/null') return '';
  if (/^[ab]\//.test(trimmed)) return trimmed.slice(2);
  return trimmed;
}
