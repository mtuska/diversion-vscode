import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseSidecarPath, type SyncConflict } from './conflictPaths.js';

export type { SyncConflict } from './conflictPaths.js';
export { parseSidecarPath } from './conflictPaths.js';

const SKIP_DIR_NAMES = new Set(['.diversion', '.git', 'node_modules', '.vscode']);
const MAX_HITS = 1000;

/**
 * Find every `*.dv-conflict[*]` sidecar inside the workspace. Pure node fs
 * walk so this module is host-agnostic (the extension, the MCP server, and
 * unit tests all use the same implementation). Bounded by MAX_HITS to keep
 * runaway scans from stalling the refresh on a misconfigured repo.
 */
export async function findSyncConflicts(workspaceRoot: string): Promise<SyncConflict[]> {
  const out: SyncConflict[] = [];
  const stack: string[] = [workspaceRoot];
  while (stack.length > 0 && out.length < MAX_HITS) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (!e.name.includes('.dv-conflict')) continue;
        const conflict = parseSidecarPath(full);
        if (conflict) {
          out.push(conflict);
          if (out.length >= MAX_HITS) break;
        }
      } else if (e.isDirectory() && !e.isSymbolicLink()) {
        stack.push(full);
      }
    }
  }
  return out.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
}
