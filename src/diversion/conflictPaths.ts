import * as path from 'node:path';

export interface SyncConflict {
  /** Absolute path to the original file (the *incoming* version after auto-update). */
  originalPath: string;
  /** Absolute path to the `<file>.dv-conflict[.N].<ext>` sidecar holding the local version. */
  sidecarPath: string;
  /**
   * Numbered conflicts (`file.dv-conflict-1.ext`) accumulate when multiple
   * sync conflicts hit the same file before resolution. 0 for the original.
   */
  index: number;
}

const CONFLICT_RE = /^(.+?)\.dv-conflict(?:-(\d+))?(\.[^./\\]+)?$/;

/**
 * Decompose a sidecar path into the original file and the conflict index.
 *
 * `Foo/bar.dv-conflict.txt`     → original: Foo/bar.txt        index: 0
 * `Foo/bar.dv-conflict-3.txt`   → original: Foo/bar.txt        index: 3
 * `Foo/baz.dv-conflict`         → original: Foo/baz            index: 0
 *
 * Returns undefined if the path doesn't look like a sidecar.
 */
export function parseSidecarPath(sidecarPath: string): SyncConflict | undefined {
  const dir = path.dirname(sidecarPath);
  const base = path.basename(sidecarPath);
  const m = CONFLICT_RE.exec(base);
  if (!m) return undefined;

  const stem = m[1]!;
  const index = m[2] ? Number.parseInt(m[2], 10) : 0;
  const trailingExt = m[3] ?? '';
  return {
    sidecarPath,
    originalPath: path.join(dir, stem + trailingExt),
    index,
  };
}
