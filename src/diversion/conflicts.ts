import * as vscode from 'vscode';
import { parseSidecarPath, type SyncConflict } from './conflictPaths.js';

export type { SyncConflict } from './conflictPaths.js';
export { parseSidecarPath } from './conflictPaths.js';

/**
 * Find every `*.dv-conflict[*]` sidecar inside the workspace. Uses VS Code's
 * file index so it's cheap on large repos.
 */
export async function findSyncConflicts(workspaceRoot: string): Promise<SyncConflict[]> {
  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(workspaceRoot),
    '**/*.dv-conflict*',
  );
  const uris = await vscode.workspace.findFiles(pattern, null, 1000);
  const out: SyncConflict[] = [];
  for (const uri of uris) {
    const conflict = parseSidecarPath(uri.fsPath);
    if (conflict) out.push(conflict);
  }
  return out.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
}
