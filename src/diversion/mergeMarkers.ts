/**
 * Turn two versions of a text file into a single document annotated with
 * standard conflict markers, so the user resolves it a block at a time.
 *
 * We emit the classic two-way marker shape rather than a diff3 one:
 *
 *     <<<<<<< Current (yours)
 *     ...
 *     =======
 *     ...
 *     >>>>>>> Incoming
 *
 * VS Code's built-in Merge Conflict extension recognises this and renders
 * "Accept Current / Accept Incoming / Accept Both / Compare" above every
 * block, which is exactly the per-block decision we want to offer. Nothing
 * here is Diversion-specific.
 *
 * Why two-way and not three-way: a genuine ancestor is not reliably
 * recoverable for a sync conflict. By the time the sidecar exists the agent
 * has already advanced the workspace onto the incoming commit, so "the base
 * commit" is the incoming version, not the common ancestor. Diffing the two
 * sides directly needs no ancestor and still isolates the regions that
 * actually differ.
 */

export interface ConflictBlock {
  /** Lines both sides agree on. Present only for `kind: 'common'`. */
  lines?: string[];
  ours?: string[];
  theirs?: string[];
  kind: 'common' | 'conflict';
}

export interface MarkerLabels {
  ours: string;
  theirs: string;
}

/**
 * Above this many cells the quadratic LCS table is not worth building (a
 * 4M-cell table on two 2000-line sides is already ~30ms and tens of MB).
 * Past it we degrade to a single whole-file conflict block, which is what
 * the user got before this existed — never worse, just not better.
 */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * Split two line arrays into alternating common / conflicting runs.
 *
 * Shared prefix and suffix are trimmed first: for the common case of a
 * localized edit in a large file that alone reduces the problem to a handful
 * of lines, and it keeps the whole file out of the LCS table.
 */
export function diffToBlocks(ours: readonly string[], theirs: readonly string[]): ConflictBlock[] {
  let start = 0;
  const maxStart = Math.min(ours.length, theirs.length);
  while (start < maxStart && ours[start] === theirs[start]) start++;

  let endOurs = ours.length;
  let endTheirs = theirs.length;
  while (endOurs > start && endTheirs > start && ours[endOurs - 1] === theirs[endTheirs - 1]) {
    endOurs--;
    endTheirs--;
  }

  const blocks: ConflictBlock[] = [];
  if (start > 0) blocks.push({ kind: 'common', lines: ours.slice(0, start) });

  const midOurs = ours.slice(start, endOurs);
  const midTheirs = theirs.slice(start, endTheirs);
  if (midOurs.length > 0 || midTheirs.length > 0) {
    blocks.push(...diffMiddle(midOurs, midTheirs));
  }

  if (endOurs < ours.length) blocks.push({ kind: 'common', lines: ours.slice(endOurs) });
  return blocks;
}

function diffMiddle(ours: readonly string[], theirs: readonly string[]): ConflictBlock[] {
  // One side empty: a pure insertion or deletion, no need to align anything.
  if (ours.length === 0 || theirs.length === 0) {
    return [{ kind: 'conflict', ours: [...ours], theirs: [...theirs] }];
  }
  if (ours.length * theirs.length > LCS_CELL_BUDGET) {
    return [{ kind: 'conflict', ours: [...ours], theirs: [...theirs] }];
  }

  const common = lcs(ours, theirs);

  const blocks: ConflictBlock[] = [];
  let i = 0, j = 0;
  let pendingOurs: string[] = [];
  let pendingTheirs: string[] = [];
  const flush = (): void => {
    if (pendingOurs.length > 0 || pendingTheirs.length > 0) {
      blocks.push({ kind: 'conflict', ours: pendingOurs, theirs: pendingTheirs });
      pendingOurs = [];
      pendingTheirs = [];
    }
  };

  for (const anchor of common) {
    while (i < ours.length && ours[i] !== anchor) pendingOurs.push(ours[i++]!);
    while (j < theirs.length && theirs[j] !== anchor) pendingTheirs.push(theirs[j++]!);
    flush();
    // Coalesce a run of consecutive agreed lines into one common block.
    const runStart = i;
    while (i < ours.length && j < theirs.length && ours[i] === theirs[j]) { i++; j++; }
    const run = ours.slice(runStart, i);
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'common') last.lines!.push(...run);
    else if (run.length > 0) blocks.push({ kind: 'common', lines: run });
  }
  while (i < ours.length) pendingOurs.push(ours[i++]!);
  while (j < theirs.length) pendingTheirs.push(theirs[j++]!);
  flush();
  return blocks;
}

/** Longest common subsequence of two line arrays, as the shared lines in order. */
function lcs(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length, m = b.length;
  // Single Int32Array rather than nested arrays — this is the hot allocation.
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (x: number, y: number): number => table[x * (m + 1) + y]!;
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      table[x * (m + 1) + y] = a[x] === b[y]
        ? at(x + 1, y + 1) + 1
        : Math.max(at(x + 1, y), at(x, y + 1));
    }
  }
  const out: string[] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push(a[x]!); x++; y++; }
    else if (at(x + 1, y) >= at(x, y + 1)) x++;
    else y++;
  }
  return out;
}

/** Standard marker tokens. VS Code's merge-conflict extension keys on these. */
const OURS_MARKER = '<<<<<<<';
const SPLIT_MARKER = '=======';
const THEIRS_MARKER = '>>>>>>>';

/**
 * True if the text already carries conflict markers, so we don't wrap an
 * in-progress resolution in a second layer of them.
 */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r?\n/).some((l) =>
    l.startsWith(OURS_MARKER) || l === SPLIT_MARKER || l.startsWith(THEIRS_MARKER));
}

export interface MarkedUp {
  text: string;
  /** How many conflicting regions the user has to decide on. */
  conflictCount: number;
}

/**
 * Render `ours` / `theirs` into one marker-annotated document.
 *
 * The original line ending and trailing-newline convention of `ours` is
 * preserved — rewriting a CRLF file as LF would show up as a whole-file
 * change in the next `dv diff`.
 */
export function buildConflictText(
  oursText: string,
  theirsText: string,
  labels: MarkerLabels,
): MarkedUp {
  const eol = /\r\n/.test(oursText) ? '\r\n' : '\n';
  const trailingNewline = oursText.endsWith('\n') || theirsText.endsWith('\n');
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);

  const blocks = diffToBlocks(ours, theirs);
  const out: string[] = [];
  let conflictCount = 0;
  for (const b of blocks) {
    if (b.kind === 'common') {
      out.push(...(b.lines ?? []));
      continue;
    }
    conflictCount++;
    out.push(`${OURS_MARKER} ${labels.ours}`);
    out.push(...(b.ours ?? []));
    out.push(SPLIT_MARKER);
    out.push(...(b.theirs ?? []));
    out.push(`${THEIRS_MARKER} ${labels.theirs}`);
  }
  return { text: out.join(eol) + (trailingNewline ? eol : ''), conflictCount };
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // A trailing newline yields a final empty element that isn't a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
