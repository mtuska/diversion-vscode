export interface CommitSummary {
  id: string;
  subject: string;
}

export interface CommitDetails {
  id: string;
  /** The branch label printed in parentheses on the `commit ... (refs)` line. */
  refs: string[];
  /** Parents listed under `Merge: <ref> <id>` (the form is `<refName> <commitId>`). */
  merge?: { refName: string; commitId: string };
  authorName: string;
  authorEmail: string;
  /** Raw date string as printed by `dv log` (format depends on --date flag). */
  date: string;
  /** Commit message (joined paragraphs). */
  message: string;
}

const ONELINE_RE = /^(dv\.commit\.\S+)\s+(.*)$/;

export function parseLogOneline(stdout: string): CommitSummary[] {
  const out: CommitSummary[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const m = ONELINE_RE.exec(line);
    if (m) out.push({ id: m[1]!, subject: m[2]! });
  }
  return out;
}

const COMMIT_HEAD_RE = /^commit\s+(dv\.commit\.\S+)\s*(?:\((.*)\))?\s*$/;
const MERGE_RE = /^Merge:\s+(\S+)\s+(\S+)\s*$/;
const AUTHOR_RE = /^Author:\s+(.+?)\s*<([^>]+)>\s*$/;
const DATE_RE = /^Date:\s+(.+?)\s*$/;

/**
 * Parse the multi-line `dv log` output. Commits are blank-line separated
 * blocks; each block has a header section, a blank line, then a tab-indented
 * commit message paragraph.
 */
export function parseLogFull(stdout: string): CommitDetails[] {
  const out: CommitDetails[] = [];
  const lines = stdout.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines.
    while (i < lines.length && lines[i]! === '') i++;
    if (i >= lines.length) break;

    const head = COMMIT_HEAD_RE.exec(lines[i]!);
    if (!head) { i++; continue; }

    const commit: CommitDetails = {
      id: head[1]!,
      refs: head[2] ? head[2].split(',').map((s) => s.trim()).filter(Boolean) : [],
      authorName: '',
      authorEmail: '',
      date: '',
      message: '',
    };
    i++;

    // Header lines until first blank.
    while (i < lines.length && lines[i]! !== '') {
      const line = lines[i]!;
      const merge = MERGE_RE.exec(line);
      const author = AUTHOR_RE.exec(line);
      const date = DATE_RE.exec(line);
      if (merge) {
        commit.merge = { refName: merge[1]!, commitId: merge[2]! };
      } else if (author) {
        commit.authorName = author[1]!;
        commit.authorEmail = author[2]!;
      } else if (date) {
        commit.date = date[1]!;
      }
      i++;
    }
    // Skip blank between header and message.
    while (i < lines.length && lines[i]! === '') i++;

    // Message: tab-indented lines until next blank-then-`commit` header.
    const messageLines: string[] = [];
    while (i < lines.length && lines[i]! !== '') {
      messageLines.push(lines[i]!.replace(/^\t/, ''));
      i++;
    }
    commit.message = messageLines.join('\n').trimEnd();
    out.push(commit);
  }
  return out;
}
