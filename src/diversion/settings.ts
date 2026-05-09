import * as vscode from 'vscode';

export interface DvSettings {
  dvPath: string | undefined;
  daemonUrl: string | undefined;
  refreshDebounceMs: number;
}

export function readSettings(): DvSettings {
  const cfg = vscode.workspace.getConfiguration('diversion');
  const dvPath = cfg.get<string>('path', '').trim();
  const daemonUrl = cfg.get<string>('daemonUrl', '').trim();
  return {
    dvPath: dvPath || undefined,
    daemonUrl: daemonUrl || undefined,
    refreshDebounceMs: Math.max(50, cfg.get<number>('refresh.debounceMs', 300)),
  };
}
