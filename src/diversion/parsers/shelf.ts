export interface ShelfInfo {
  /** Display name. */
  name: string;
  /** Stable ID if dv prints one (e.g. `dv.shelf.<uuid>`). */
  id?: string;
  /** Creation date / branch / extra metadata if present. */
  description?: string;
  /** Raw line preserved for fallback display. */
  raw: string;
}

const EMPTY_PATTERNS = [
  /^no shelves/i,
  /^no shelved/i,
];

const HEADER_PATTERNS = [
  /^name\b/i,
  /^shelf\b/i,
  /^id\b/i,
];

const SHELF_ID_RE = /^(dv\.shelf\.\S+)\s+(.+?)(?:\s{2,}(.+))?$/;

/**
 * Parse `dv shelf` (no-args) output. Format isn't documented in `dv help
 * shelf` and we couldn't capture it against a populated list. The parser
 * tolerates several plausible shapes:
 *
 *   `dv.shelf.<id>   <name>   <date>?`
 *   `<name>\t<date>`  (TSV)
 *   `<name>          <date>`  (whitespace columns)
 *   plain `<name>` lines
 *
 * Anything we can't parse becomes a ShelfInfo with the raw line preserved.
 * Update the heuristics when a real format becomes visible.
 */
export function parseShelfList(stdout: string): ShelfInfo[] {
  const out: ShelfInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (EMPTY_PATTERNS.some((p) => p.test(line))) return [];
    if (HEADER_PATTERNS.some((p) => p.test(line))) continue;

    out.push(splitShelfLine(line));
  }
  return out;
}

function splitShelfLine(line: string): ShelfInfo {
  // Strategy 1: starts with dv.shelf.<id>
  const m = SHELF_ID_RE.exec(line);
  if (m) {
    return {
      id: m[1]!,
      name: m[2]!.trim(),
      description: m[3]?.trim(),
      raw: line,
    };
  }
  // Strategy 2: tab-separated.
  if (line.includes('\t')) {
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) return { name: cols[0]!, description: cols.slice(1).join(' '), raw: line };
    if (cols.length === 1) return { name: cols[0]!, raw: line };
  }
  // Strategy 3: 2+ spaces as column separator.
  const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (cols.length >= 2) return { name: cols[0]!, description: cols.slice(1).join(' '), raw: line };
  return { name: line.trim(), raw: line };
}
