import * as vscode from 'vscode';

export interface DvSettings {
  dvPath: string | undefined;
  daemonUrl: string | undefined;
  refreshDebounceMs: number;
  scmShowAllRepoChanges: boolean;
  maxParallelProcesses: number;
  repositoryScanMaxDepth: number;
}

export function readSettings(): DvSettings {
  const cfg = vscode.workspace.getConfiguration('diversion');
  const dvPath = cfg.get<string>('path', '').trim();
  const daemonUrl = cfg.get<string>('daemonUrl', '').trim();
  return {
    dvPath: dvPath || undefined,
    daemonUrl: daemonUrl || undefined,
    refreshDebounceMs: Math.max(50, cfg.get<number>('refresh.debounceMs', 300)),
    scmShowAllRepoChanges: cfg.get<boolean>('scm.showAllRepoChanges', false),
    maxParallelProcesses: Math.max(1, Math.min(32, cfg.get<number>('maxParallelProcesses', 4))),
    repositoryScanMaxDepth: Math.max(0, Math.min(10, cfg.get<number>('repositoryScanMaxDepth', 1))),
  };
}
