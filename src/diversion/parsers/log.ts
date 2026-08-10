import type { CommitDetails } from '../types.js';

/**
 * Parser for `dv log`'s multi-line output.
 *
 * Reads normally come from the CoreAPI — this exists for the one query the
 * CoreAPI cannot answer: `dv log --show-squashed <path>`, which surfaces the
 * commits a merge squashed away so a file's history stays intact across
 * merges. The object-history endpoint has no equivalent parameter.
 */

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

    // Message: tab-indented lines, with embedded blank lines acting as
    // paragraph separators. Two consecutive blank lines (or a `commit
    // <id>` header) marks the end of the message — `dv log` separates
    // commits with one tab-indented body, then two blank lines, then the
    // next `commit` header.
    const messageLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (COMMIT_HEAD_RE.test(line)) break;
      if (line === '') {
        // Blank line — could be a paragraph separator OR the start of
        // the gap before the next commit. Look ahead: if the next non-
        // empty line is a `commit` header (or EOF), this blank is the
        // terminator and we drop it. Otherwise it's a paragraph break.
        let j = i + 1;
        while (j < lines.length && lines[j]! === '') j++;
        if (j >= lines.length || COMMIT_HEAD_RE.test(lines[j]!)) {
          i = j;
          break;
        }
        messageLines.push('');
        i++;
        continue;
      }
      messageLines.push(line.replace(/^\t/, ''));
      i++;
    }
    commit.message = messageLines.join('\n').trimEnd();
    out.push(commit);
  }
  return out;
}
