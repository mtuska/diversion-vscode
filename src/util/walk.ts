import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SKIP_DIR_NAMES = new Set(['.diversion', '.git', 'node_modules']);

/**
 * Recursively list every regular-file path under `root` (depth-first).
 * Symlinks are not followed — they would risk loops that no per-file cap
 * really protects against. Returns absolute paths.
 *
 * Bounded by `maxFiles` (default 5000) so a "new" directory containing a
 * generated build tree doesn't crash the SCM panel — once we hit the cap
 * we stop walking and return what we have. The cap is generous for normal
 * workflows; if users need higher limits we can promote this to a setting.
 */
export async function listFilesRecursive(root: string, maxFiles = 5000): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
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
        out.push(full);
        if (out.length >= maxFiles) return out;
      } else if (e.isDirectory()) {
        stack.push(full);
      }
      // Symlinks: skip silently. Worst case we miss a few files; better than
      // chasing a loop on the cwd of a built artefact.
    }
  }
  return out;
}
