export interface BranchInfo {
  name: string;
  id: string;
  /** Tip commit ID for this branch. */
  commitId: string;
}

const BRANCH_RE = /^branch\s+(\S+)\s+\((\S+)\)\s*$/;
const COMMIT_RE = /^commit\s+(\S+)\s*$/;

/**
 * Parse `dv branch` output. Each entry is two lines:
 *
 *   branch <name> (<branch_id>)
 *   commit <commit_id>
 *
 * Entries are separated by blank lines.
 */
export function parseBranchList(stdout: string): BranchInfo[] {
  const out: BranchInfo[] = [];
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const branchMatch = BRANCH_RE.exec(lines[i]!);
    if (!branchMatch) continue;
    const next = lines[i + 1] ?? '';
    const commitMatch = COMMIT_RE.exec(next);
    if (!commitMatch) continue;
    out.push({
      name: branchMatch[1]!,
      id: branchMatch[2]!,
      commitId: commitMatch[1]!,
    });
    i++; // skip the commit line we just consumed
  }
  return out;
}
