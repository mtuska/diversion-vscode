export interface LockInfo {
  /** Workspace-relative path to the locked file or directory. */
  path: string;
  /** Holder name/email if we could parse it. May be undefined. */
  holder?: string;
  /** Raw line for debugging when our heuristics misfire. */
  raw: string;
}

const EMPTY_PATTERNS = [
  /^no active locks/i,
  /^no locks/i,
  /^no lock/i,
];

const HEADER_PATTERNS = [
  /^path\b/i,
  /^lock\b/i,
];

const HOLDER_INLINE_PATTERNS = [
  /\blocked by\s+(.+?)\s*$/i,
  /\bby\s+(\S+@\S+)\s*$/i,
  /\(\s*([^)]+)\s*\)\s*$/,
];

/**
 * Parse `dv lock` (no-args) output into LockInfo entries.
 *
 * The exact output shape isn't documented in `dv help lock` and we couldn't
 * capture it against a populated lock list (the test workspace had none).
 * The parser is intentionally lenient: it skips the empty/header lines and
 * tries multiple heuristics for splitting each remaining line into
 * path + holder. Anything we can't parse becomes a `LockInfo` with the raw
 * line preserved on `raw` and `holder` undefined — better than silently
 * losing locks. Update the heuristics when we see real output in the wild.
 */
export function parseLockList(stdout: string): LockInfo[] {
  const out: LockInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (EMPTY_PATTERNS.some((p) => p.test(line))) return [];
    if (HEADER_PATTERNS.some((p) => p.test(line))) continue;

    out.push(splitLine(line));
  }
  return out;
}

function splitLine(line: string): LockInfo {
  // Strategy 1: explicit "Locked by"/"by"/"(holder)" anchors at end.
  for (const pat of HOLDER_INLINE_PATTERNS) {
    const m = pat.exec(line);
    if (m) {
      const holder = m[1]!.trim();
      const path = line.slice(0, m.index).replace(/[\s|:,-]+$/, '').trim();
      if (path) return { path, holder, raw: line };
    }
  }
  // Strategy 2: tab-separated columns — first column is path.
  if (line.includes('\t')) {
    const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) return { path: cols[0]!, holder: cols.slice(1).join(' '), raw: line };
    if (cols.length === 1) return { path: cols[0]!, raw: line };
  }
  // Strategy 3: 2+ spaces as column separator.
  const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (cols.length >= 2) return { path: cols[0]!, holder: cols.slice(1).join(' '), raw: line };
  // Last resort: treat the whole line as a path.
  return { path: line.trim(), raw: line };
}
