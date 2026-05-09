import * as vscode from 'vscode';

/**
 * Watch a workspace folder for any file change/create/delete and invoke the
 * callback. Excludes obvious noise (.diversion internal files, .vscode, etc.).
 *
 * The pattern is rooted at `root` and recursive.
 */
export function watchWorkspace(
  root: string,
  onChange: (uri: vscode.Uri) => void,
): vscode.Disposable {
  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(root),
    '**/*',
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const handler = (uri: vscode.Uri) => {
    if (isIgnored(uri.fsPath, root)) return;
    onChange(uri);
  };
  const disposables = [
    watcher,
    watcher.onDidChange(handler),
    watcher.onDidCreate(handler),
    watcher.onDidDelete(handler),
  ];
  return { dispose: () => { for (const d of disposables) d.dispose(); } };
}

function isIgnored(fsPath: string, _root: string): boolean {
  // Avoid feedback loops from Diversion's own metadata and editor temp files.
  return (
    fsPath.includes('/.diversion/') ||
    fsPath.includes('/.git/') ||
    fsPath.includes('/.vscode/') ||
    fsPath.endsWith('~') ||
    /\.swp$/.test(fsPath)
  );
}
