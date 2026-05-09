import type { ChangeKind, FileChange } from '../types.js';

export interface ParsedStatus {
  repoName: string;
  repoId: string;
  branchName: string;
  branchId: string;
  commitId: string;
  /** "<workspace_name> @ <host>". */
  workspaceLabel: string;
  workspaceId: string;
  totalChangedPaths: number;
  totalChangedFiles: number;
  changes: FileChange[];
  /** Lines we couldn't parse — surfaced for logging, not control flow. */
  unparsedHeaderLines: string[];
}

const SECTION_KIND_MAP: Record<string, ChangeKind> = {
  new: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

/**
 * Parse `dv status` (default form). We tolerate missing optional sections;
 * a clean workspace produces only the header lines.
 */
export function parseStatus(stdout: string): ParsedStatus {
  const lines = stdout.split(/\r?\n/);
  const result: ParsedStatus = {
    repoName: '',
    repoId: '',
    branchName: '',
    branchId: '',
    commitId: '',
    workspaceLabel: '',
    workspaceId: '',
    totalChangedPaths: 0,
    totalChangedFiles: 0,
    changes: [],
    unparsedHeaderLines: [],
  };

  let i = 0;
  // Skip leading blank lines.
  while (i < lines.length && lines[i]!.trim() === '') i++;

  // Header section — order is observed but we match each line by pattern,
  // not position, in case dv adds/reorders fields.
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;
    if (matchHeader(line, result)) continue;
    // First non-header line is either a section header (`X:`) or content.
    if (/^[A-Za-z][A-Za-z ]*:\s*$/.test(line)) break;
    result.unparsedHeaderLines.push(line);
  }

  // Section parsing: lines like `Modified:` followed by tab-indented paths.
  let currentKind: ChangeKind | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') {
      currentKind = undefined;
      continue;
    }
    const sectionMatch = /^([A-Za-z][A-Za-z ]*):\s*$/.exec(line);
    if (sectionMatch) {
      const key = sectionMatch[1]!.trim().toLowerCase();
      currentKind = SECTION_KIND_MAP[key];
      continue;
    }
    if (currentKind && /^[\t ]/.test(line)) {
      const path = line.replace(/^[\t ]+/, '').trim();
      if (path) result.changes.push({ kind: currentKind, path });
    }
  }

  return result;
}

function matchHeader(line: string, into: ParsedStatus): boolean {
  // "In repo <name> <id>"
  let m = /^In repo\s+(\S+)\s+(\S+)\s*$/.exec(line);
  if (m) { into.repoName = m[1]!; into.repoId = m[2]!; return true; }

  // "On branch <name> <id>"
  m = /^On branch\s+(\S+)\s+(\S+)\s*$/.exec(line);
  if (m) { into.branchName = m[1]!; into.branchId = m[2]!; return true; }

  // "Cloud workspace is over commit <id>"
  m = /^Cloud workspace is over commit\s+(\S+)\s*$/.exec(line);
  if (m) { into.commitId = m[1]!; return true; }

  // "Working in workspace <label-with-spaces> (<id>)"
  m = /^Working in workspace\s+(.+?)\s+\((\S+)\)\s*$/.exec(line);
  if (m) { into.workspaceLabel = m[1]!; into.workspaceId = m[2]!; return true; }

  // "Total modified paths: N (X files)"
  m = /^Total modified paths:\s+(\d+)\s+\((\d+)\s+files?\)\s*$/.exec(line);
  if (m) {
    into.totalChangedPaths = Number.parseInt(m[1]!, 10);
    into.totalChangedFiles = Number.parseInt(m[2]!, 10);
    return true;
  }
  return false;
}
