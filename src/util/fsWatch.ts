import * as path from 'node:path';
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

const SEP = path.sep;
const IGNORED_SEGMENTS = [
  `${SEP}.diversion${SEP}`,
  `${SEP}.git${SEP}`,
  `${SEP}.vscode${SEP}`,
];

function isIgnored(fsPath: string, _root: string): boolean {
  // Avoid feedback loops from Diversion's own metadata and editor temp files.
  for (const seg of IGNORED_SEGMENTS) {
    if (fsPath.includes(seg)) return true;
  }
  return fsPath.endsWith('~') || /\.swp$/.test(fsPath);
}
