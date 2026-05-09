import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Logger } from './util/log.js';
import { DaemonClient, DaemonUnavailableError } from './diversion/daemon.js';
import { detectRepo, findDiversionRoot, findNestedDiversionRoots } from './diversion/detect.js';
import { Repo } from './diversion/repo.js';
import { readSettings } from './diversion/settings.js';
import { setDvConcurrencyLimit } from './diversion/cli.js';
import { DiversionScmProvider } from './scm/provider.js';
import { QuickDiff, DV_SCHEME } from './scm/quickDiff.js';
import { CommitContentProvider, DV_COMMIT_SCHEME } from './scm/commitContent.js';
import { LockDecorationProvider } from './scm/lockDecorations.js';
import { ChangeDecorationsProvider } from './scm/changeDecorations.js';
import { IgnoreManager } from './util/ignore.js';
import { Blame } from './scm/blame.js';
import { ShelvesTreeProvider, type ShelfNode } from './scm/shelvesView.js';
import { watchWorkspace } from './util/fsWatch.js';
import { StatusBar } from './ui/statusBar.js';
import { showLogWebview } from './ui/webviews/log.js';
import { looksBinary } from './util/binary.js';
import { isInsideOrEqual } from './util/path.js';
import { deleteSidecar } from './diversion/repo.js';
import type { ChangeKind } from './diversion/types.js';

let logger: Logger | undefined;
let statusBar: StatusBar | undefined;
let quickDiff: QuickDiff | undefined;
let lockDecorations: LockDecorationProvider | undefined;
let changeDecorations: ChangeDecorationsProvider | undefined;
let blame: Blame | undefined;
let shelvesProvider: ShelvesTreeProvider | undefined;
let commitContent: CommitContentProvider | undefined;
const providers = new Map<string, DiversionScmProvider>();
const ignoreManagers = new Map<string, IgnoreManager>();
let activationContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationContext = context;
  logger = new Logger();
  const log = logger;
  const folders = vscode.workspace.workspaceFolders ?? [];
  log.info(`Diversion extension activating; ${folders.length} workspace folder(s):`);
  for (const f of folders) log.info(`  • ${f.uri.fsPath}`);
  // The output channel is created above and discoverable via the Output
  // dropdown / `Diversion: Show Output` command, but we no longer auto-
  // surface it on activation — it was useful during early development
  // and noisy thereafter.

  statusBar = new StatusBar(log);
  const repoLookup = {
    rootForPath: (fsPath: string) => {
      for (const [root, p] of providers) {
        if (isInsideOrEqual(root, fsPath)) {
          return { root, dvPath: p.repo.binaryPath };
        }
      }
      return undefined;
    },
    kindForPath: (fsPath: string) => changeDecorations?.kindForPath(fsPath),
  };
  quickDiff = new QuickDiff(repoLookup, log);
  commitContent = new CommitContentProvider(repoLookup, log);

  lockDecorations = new LockDecorationProvider(
    () => [...providers.values()].map((p) => p.repo),
    log,
  );
  // Instantiate before repoLookup uses it via closure (the kindForPath
  // arrow above captures the binding, not the value).
  changeDecorations = new ChangeDecorationsProvider(log);
  blame = new Blame(
    {
      forUri: (uri) => {
        const provider = providerForUri(uri);
        return provider ? { repo: provider.repo, root: provider.repo.root } : undefined;
      },
    },
    log,
  );
  shelvesProvider = new ShelvesTreeProvider(
    () => [...providers.values()].map((p) => p.repo),
    log,
  );

  context.subscriptions.push(
    statusBar,
    quickDiff,
    commitContent,
    lockDecorations,
    changeDecorations,
    blame,
    vscode.workspace.registerTextDocumentContentProvider(DV_SCHEME, quickDiff),
    vscode.workspace.registerTextDocumentContentProvider(DV_COMMIT_SCHEME, commitContent),
    vscode.window.registerFileDecorationProvider(lockDecorations),
    vscode.window.registerFileDecorationProvider(changeDecorations),
    vscode.window.registerTreeDataProvider('diversion.shelves', shelvesProvider),
    { dispose: () => log.dispose() },
    {
      dispose: () => {
        for (const p of providers.values()) p.dispose();
        providers.clear();
      },
    },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('diversion.refresh', refreshAllCommand),
    vscode.commands.registerCommand('diversion.commit', commitCommand),
    vscode.commands.registerCommand('diversion.generateCommitMessage', generateCommitMessageCommand),
    vscode.commands.registerCommand('diversion.commitSelected', commitSelectedCommand),
    vscode.commands.registerCommand('diversion.stage', stageCommand),
    vscode.commands.registerCommand('diversion.unstage', unstageCommand),
    vscode.commands.registerCommand('diversion.stageAll', stageAllCommand),
    vscode.commands.registerCommand('diversion.unstageAll', unstageAllCommand),
    vscode.commands.registerCommand('diversion.openResource', openResourceCommand),
    vscode.commands.registerCommand('diversion.openFile', openFileCommand),
    vscode.commands.registerCommand('diversion.discardChanges', discardChangesCommand),
    vscode.commands.registerCommand('diversion.discardAll', discardAllCommand),
    vscode.commands.registerCommand('diversion.viewHistory', viewHistoryCommand),
    vscode.commands.registerCommand('diversion.openInWeb', openInWebCommand),
    vscode.commands.registerCommand('diversion.switchBranch', switchBranchCommand),
    vscode.commands.registerCommand('diversion.createBranch', createBranchCommand),
    vscode.commands.registerCommand('diversion.merge', mergeCommand),
    vscode.commands.registerCommand('diversion.lockFile', lockFileCommand),
    vscode.commands.registerCommand('diversion.unlockFile', unlockFileCommand),
    vscode.commands.registerCommand('diversion.listLocks', listLocksCommand),
    vscode.commands.registerCommand('diversion.resolveConflict', resolveConflictCommand),
    vscode.commands.registerCommand('diversion.markResolved', markResolvedCommand),
    vscode.commands.registerCommand('diversion.showOutput', () => logger?.show()),
    vscode.commands.registerCommand('diversion.moreActions', moreActionsCommand),
    vscode.commands.registerCommand('diversion.pauseSync', pauseSyncCommand),
    vscode.commands.registerCommand('diversion.resumeSync', resumeSyncCommand),
    vscode.commands.registerCommand('diversion.updateWorkspace', updateWorkspaceCommand),
    vscode.commands.registerCommand('diversion.verify', verifyCommand),
    vscode.commands.registerCommand('diversion.toggleBlame', () => blame?.toggle()),
    vscode.commands.registerCommand('diversion.daemonHealth', daemonHealthCommand),
    vscode.commands.registerCommand('diversion.perfTrace', perfTraceCommand),
    vscode.commands.registerCommand('diversion.clearCommitCache', clearCommitCacheCommand),
    vscode.commands.registerCommand('diversion.cherryPickCommit', cherryPickCommand),
    vscode.commands.registerCommand('diversion.revertCommit', revertCommitCommand),
    vscode.commands.registerCommand('diversion.revertToCommit', revertToCommitCommand),
    vscode.commands.registerCommand('diversion.refreshShelves', () => shelvesProvider?.refresh()),
    vscode.commands.registerCommand('diversion.createShelf', createShelfCommand),
    vscode.commands.registerCommand('diversion.applyShelf', applyShelfCommand),
    vscode.commands.registerCommand('diversion.deleteShelf', deleteShelfCommand),
    vscode.commands.registerCommand('diversion.renameShelf', renameShelfCommand),
    vscode.commands.registerCommand('diversion.shelveAndSwitchBranch', shelveAndSwitchBranchCommand),
  );

  // Apply concurrency cap before any dv calls fire.
  setDvConcurrencyLimit(readSettings().maxParallelProcesses);

  await healthCheck(log);
  await scanWorkspaceFolders();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void scanWorkspaceFolders(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('diversion.maxParallelProcesses')) {
        const next = readSettings().maxParallelProcesses;
        setDvConcurrencyLimit(next);
        log.info(`[settings] dv concurrency limit → ${next}`);
      }
      if (e.affectsConfiguration('diversion.repositoryScanMaxDepth')) {
        // Re-scan to pick up nested repos newly within the depth budget.
        // (We don't *un-register* repos when the depth shrinks — that
        // would tear down providers mid-session; a window reload covers
        // the rare "I want fewer repos showing up" direction.)
        void scanWorkspaceFolders();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) for (const p of providers.values()) p.scheduleRefresh(50);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
    // Direct editor events. These fire synchronously with the user
    // action, ahead of `createFileSystemWatcher`, so the SCM panel
    // reacts within a frame instead of waiting on the watcher's
    // debounce + dv round trip.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      onDocumentMutated(doc.uri);
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      for (const uri of e.files) onDocumentMutated(uri);
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) onDocumentMutated(uri);
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const f of e.files) {
        onDocumentMutated(f.oldUri);
        onDocumentMutated(f.newUri);
      }
    }),
  );

  if (providers.size === 0) {
    log.warn(
      'No Diversion workspaces detected. The extension activated but no repo ' +
      'was registered. Common causes: (1) no .diversion/ directory in the open ' +
      'folder; (2) the dv daemon is not running (run `dv status` to start it); ' +
      '(3) the workspace path doesn\'t match the daemon\'s registry — check ' +
      '~/.diversion/config.json. See the Diversion output channel for details.',
    );
  } else {
    log.info(`Activation complete. ${providers.size} Diversion repo(s) registered.`);
  }
}

export function deactivate(): void {
  logger?.info('Diversion extension deactivating');
  for (const p of providers.values()) p.dispose();
  providers.clear();
  statusBar?.dispose();
  quickDiff?.dispose();
}

async function healthCheck(log: Logger): Promise<void> {
  const settings = readSettings();
  const daemon = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
  try {
    const health = await daemon.health();
    log.info(`Daemon healthy at ${await daemon.baseUrl()} (dv ${health.Version})`);
    warnIfIncompatibleVersion(log, health.Version);
    // Wire up the persistent commit-content cache once we know dv's version.
    // Cache is segmented by version so old-version artifacts don't leak in.
    if (commitContent && activationContext) {
      commitContent.attachPersistence(activationContext.globalStorageUri, health.Version);
    }
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      log.warn(`Daemon unreachable: ${err.message}. Filesystem fallback in use.`);
    } else {
      log.error('Unexpected error contacting daemon', err);
    }
  }
}

/**
 * Warn (once) if the running `dv` is on a different major version than what
 * we tested against. v0.1 was developed against dv v0.9.x; we surface a
 * notification when major (or minor for 0.x) shifts, but don't refuse to
 * activate — the parsers are tolerant and this is a soft compatibility check.
 */
function warnIfIncompatibleVersion(log: Logger, version: string): void {
  // Strip leading 'v' and parse first three numbers.
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    log.warn(`Could not parse dv version "${version}" — proceeding without compat check.`);
    return;
  }
  const [, majorRaw, minorRaw] = m;
  const major = Number.parseInt(majorRaw!, 10);
  const minor = Number.parseInt(minorRaw!, 10);

  // Tested band: dv 0.9.x. While dv is pre-1.0, the minor version is the
  // breaking-change axis; promote 1.x to a warn when it lands.
  const supportedMajor = 0;
  const supportedMinor = 9;
  if (major === supportedMajor && minor === supportedMinor) return;

  const direction = major > supportedMajor || (major === supportedMajor && minor > supportedMinor)
    ? 'newer'
    : 'older';
  const msg = `Diversion: this extension was tested against dv ${supportedMajor}.${supportedMinor}.x — you have ${version} (${direction}). Output parsing may be off; report any glitches.`;
  log.warn(msg);
  void vscode.window.showWarningMessage(msg);
}

async function scanWorkspaceFolders(): Promise<void> {
  const log = logger!;
  const settings = readSettings();
  const daemon = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
  const folders = vscode.workspace.workspaceFolders ?? [];

  // Group VS Code workspace folders by the Diversion repo root they live
  // inside (or are equal to). The providers map is keyed by repo root,
  // not folder path: opening multiple sub-folders of the same repo
  // registers exactly one provider, and that provider gets the union of
  // all open folders so it can filter its SCM display to just those.
  const foldersByRoot = new Map<string, { id: import('./diversion/types.js').RepoIdentity; folders: string[] }>();

  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') continue;
    const folderPath = folder.uri.fsPath;

    // Detection candidates: the workspace folder itself (which `detectRepo`
    // resolves via its upward `.diversion` walk) plus any nested repos
    // discovered up to `repositoryScanMaxDepth` levels below it. The
    // upward case handles "user opened a sub-folder of a repo"; the
    // downward case handles "user opened a parent folder containing
    // multiple sibling repos". Same shape as git's two-axis discovery.
    const candidates: string[] = [folderPath];
    if (settings.repositoryScanMaxDepth > 0) {
      try {
        const nested = await findNestedDiversionRoots(folderPath, settings.repositoryScanMaxDepth);
        for (const r of nested) if (!candidates.includes(r)) candidates.push(r);
      } catch (err) {
        log.warn(`Nested repo scan failed for ${folderPath}: ${err}`);
      }
    }

    let firstFailureLogged = false;
    for (const candidate of candidates) {
      let id;
      try {
        id = await detectRepo(daemon, candidate);
      } catch (err) {
        log.error(`Detection failed for ${candidate}`, err);
        continue;
      }
      if (!id) {
        // Only emit the diagnostic for the workspace folder itself —
        // nested probes are best-effort and shouldn't spam warnings
        // when a child directory turns out not to be a repo.
        if (candidate === folderPath && !firstFailureLogged) {
          firstFailureLogged = true;
          const walkRoot = await findDiversionRoot(folderPath);
          if (walkRoot) {
            log.warn(
              `  ↳ found .diversion at ${walkRoot} but daemon registry didn't match — ` +
              `path-comparison or daemon-not-running issue`,
            );
          } else {
            log.warn(`  ↳ no .diversion/ ancestor walking up from ${folderPath}`);
          }
        }
        continue;
      }

      const root = id.workspacePath;
      const entry = foldersByRoot.get(root);
      if (entry) {
        if (!entry.folders.includes(folderPath)) entry.folders.push(folderPath);
      } else {
        foldersByRoot.set(root, { id, folders: [folderPath] });
      }
    }
  }

  for (const [root, { id, folders: openFolders }] of foldersByRoot) {
    let provider = providers.get(root);
    if (!provider) {
      const repo = new Repo(daemon, id, settings.dvPath, log);
      provider = new DiversionScmProvider(
        repo, log, activationContext!.workspaceState, quickDiff, changeDecorations,
      );
      providers.set(root, provider);

      // Per-repo ignore matcher. Loads .dvignore + .gitignore files
      // anywhere under the repo and feeds the change-decorations provider
      // so ignored files render gray in the Explorer.
      const ignoreMgr = new IgnoreManager(log);
      ignoreManagers.set(root, ignoreMgr);
      void ignoreMgr.load(root).then(() => {
        changeDecorations?.attachIgnoreManager(root, ignoreMgr);
      });

      const sample = openFolders[0] ?? root;
      const note = sample === root ? '' : ` [open folder: ${sample}${openFolders.length > 1 ? ` +${openFolders.length - 1} more` : ''}]`;
      log.info(
        `Registered SCM provider for ${id.repoName} on ${id.branchName || '<unknown>'} ` +
        `(${id.commitId || '<no commit>'}) at ${root}${note}`,
      );
      provider.scheduleRefresh(0);
    }

    // Tell the provider which folders are open under it, so the SCM panel
    // can filter its display. If the user opened the repo root itself,
    // pass that — the provider treats "root in openFolders" as "no filter".
    // The setting below lets users override and always see the full repo.
    const showAll = settings.scmShowAllRepoChanges;
    provider.setOpenFolders(showAll ? [root] : openFolders);

    // One watcher per open folder so VS Code's workspace-folder-scoped FS
    // event delivery still works for sub-dir opens. They all feed the same
    // provider — refresh fires regardless of which folder the change came from.
    const ignoreMgrForRoot = ignoreManagers.get(root);
    for (const folderPath of openFolders) {
      const watcherDisposable = watchWorkspace(folderPath, async (uri) => {
        provider!.scheduleRefresh(settings.refreshDebounceMs);
        void lockDecorations?.refresh();
        commitContent?.invalidate(uri.fsPath);
        // If a .dvignore / .gitignore file changed, reload the matcher
        // and re-fire decorations across the whole repo.
        if (ignoreMgrForRoot) {
          const reloaded = await ignoreMgrForRoot.maybeReload(uri.fsPath);
          if (reloaded) changeDecorations?.refresh();
        }
      });
      activationContext?.subscriptions.push(watcherDisposable);
    }
  }

  for (const [key, provider] of [...providers.entries()]) {
    if (!foldersByRoot.has(key)) {
      provider.dispose();
      providers.delete(key);
      changeDecorations?.detachIgnoreManager(key);
      ignoreManagers.delete(key);
      log.info(`Removed SCM provider for ${key}`);
    }
  }

  await vscode.commands.executeCommand('setContext', 'diversion.hasRepo', providers.size > 0);
  updateStatusBar();
}

function updateStatusBar(): void {
  if (!statusBar) return;
  const provider = activeProvider();
  if (!provider) {
    statusBar.update(undefined);
    return;
  }
  // AgentAPI sync state is best-effort; if the call fails the bar
  // still renders, just without the spinner / paused indicator.
  void provider.repo.syncStatus().then((sync) => {
    if (activeProvider() === provider) statusBar?.update(provider.repo, sync);
  });
}

function activeProvider(): DiversionScmProvider | undefined {
  if (providers.size === 0) return undefined;
  if (providers.size === 1) return [...providers.values()][0];
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    for (const [root, p] of providers) {
      if (isInsideOrEqual(root, editor.document.uri.fsPath)) return p;
    }
  }
  return [...providers.values()][0];
}

// ──────────────────────────── commands ────────────────────────────

async function moreActionsCommand(): Promise<void> {
  type Item = vscode.QuickPickItem & { command?: string };
  const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items: Item[] = [
    sep('Actions'),
    { label: '$(check) Commit (all changes)', command: 'diversion.commit' },
    { label: '$(discard) Discard All Changes…', command: 'diversion.discardAll' },
    { label: '$(refresh) Refresh', command: 'diversion.refresh' },
    sep('Branch'),
    { label: '$(git-branch) Switch Branch…', command: 'diversion.switchBranch' },
    { label: '$(add) Create Branch…', command: 'diversion.createBranch' },
    { label: '$(git-merge) Merge Into Current…', command: 'diversion.merge' },
    sep('Sync'),
    { label: '$(sync) Update Workspace', command: 'diversion.updateWorkspace' },
    { label: '$(debug-pause) Pause Sync', command: 'diversion.pauseSync' },
    { label: '$(debug-continue) Resume Sync', command: 'diversion.resumeSync' },
    sep('Locks'),
    { label: '$(lock) Lock File', command: 'diversion.lockFile' },
    { label: '$(unlock) Unlock File', command: 'diversion.unlockFile' },
    { label: '$(list-tree) List Locks…', command: 'diversion.listLocks' },
    sep('View'),
    { label: '$(history) View History', command: 'diversion.viewHistory' },
    { label: '$(globe) Open in Web UI', command: 'diversion.openInWeb' },
    { label: '$(eye) Toggle Blame (Annotation)', command: 'diversion.toggleBlame' },
    { label: '$(verified) Verify Repository Integrity', command: 'diversion.verify' },
    { label: '$(server) Show Daemon Health', command: 'diversion.daemonHealth' },
    { label: '$(watch) Run Performance Trace', command: 'diversion.perfTrace' },
    { label: '$(output) Show Output Channel', command: 'diversion.showOutput' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Diversion: choose an action' });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}

async function pauseSyncCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'dv workspace pause' },
      () => provider.repo.pauseSync(),
    );
    await provider.refresh();
    updateStatusBar();
    void vscode.window.showInformationMessage('Diversion: sync paused.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: pause failed: ${(err as Error).message}`);
  }
}

async function resumeSyncCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'dv workspace resume' },
      () => provider.repo.resumeSync(),
    );
    await provider.refresh();
    updateStatusBar();
    void vscode.window.showInformationMessage('Diversion: sync resumed.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: resume failed: ${(err as Error).message}`);
  }
}

async function updateWorkspaceCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: 'dv update' },
      () => provider.repo.updateWorkspace(),
    );
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: update failed: ${(err as Error).message}`);
  }
}

async function perfTraceCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) {
    void vscode.window.showInformationMessage('Diversion: no active workspace.');
    return;
  }
  const log = logger!;
  log.show();
  log.info('────────────────────────────────────────');
  log.info('[perf] Diversion: Run Performance Trace');
  log.info('────────────────────────────────────────');

  const repo = provider.repo;
  const root = repo.root;

  // The raw `runDv` measurement so we know dv invocation cost without our parsing.
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      log.info(`[perf] ${label}: ${Date.now() - t0}ms`);
      return r;
    } catch (err) {
      log.warn(`[perf] ${label}: FAILED after ${Date.now() - t0}ms — ${(err as Error).message}`);
      return undefined;
    }
  };

  log.info(`[perf] repo=${repo.info.repoName} root=${root}`);
  log.info(`[perf] dv=${repo.binaryPath ?? 'dv'} (PATH lookup)`);

  await time('dv status (full state)', () => repo.getState());
  await time('dv status (full state) — warm', () => repo.getState());
  await time('dv branch', () => repo.listBranches());
  await time('dv log -n 100 --date iso', () => repo.logFull(100));
  await time('dv log -n 10 --date iso', () => repo.logFull(10));

  const commits = await repo.logFull(5).catch(() => []);
  if (commits.length > 0) {
    const latestId = commits[0]!.id;
    const earlierId = commits[Math.min(commits.length - 1, 4)]!.id;
    await time(`dv show ${latestId} --name-status`, () => repo.fileChangesForCommit(latestId));
    await time(`dv show ${latestId} --name-status — warm`, () => repo.fileChangesForCommit(latestId));
    await time(`dv show ${earlierId} --name-status`, () => repo.fileChangesForCommit(earlierId));
  }

  // Sample: pick the first changed text file (if any) and time the QuickDiff path.
  const state = await repo.getState().catch(() => undefined);
  const sample = state?.changes.find((c) => c.kind === 'modified');
  if (sample) {
    const sampleAbs = path.join(root, sample.path);
    log.info(`[perf] sample file: ${sample.path}`);
    await time(`dv diff <file>          (cold)`, async () => {
      // re-spawn through our cli runner with a unique file path each time
      const { runDvOrThrow } = await import('./diversion/cli.js');
      await runDvOrThrow(['diff', '--color', 'never', sample.path], { cwd: root, dvPath: repo.binaryPath, timeoutMs: 30_000 });
    });
    await time(`dv diff <file>          (warm)`, async () => {
      const { runDvOrThrow } = await import('./diversion/cli.js');
      await runDvOrThrow(['diff', '--color', 'never', sample.path], { cwd: root, dvPath: repo.binaryPath, timeoutMs: 30_000 });
    });
    void sampleAbs;
  } else {
    log.info('[perf] no modified text file found — skipping diff timing.');
  }

  // Daemon-only: HTTP roundtrip to /workspaces. Pure local IPC, the
  // closest thing to a "process spawn cost" baseline we have.
  await time('daemon GET /workspaces  (cold)', async () => {
    const { DaemonClient } = await import('./diversion/daemon.js');
    const settings = readSettings();
    const d = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
    await d.workspaces();
  });
  await time('daemon GET /workspaces  (warm)', async () => {
    const { DaemonClient } = await import('./diversion/daemon.js');
    const settings = readSettings();
    const d = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
    await d.workspaces();
  });

  log.info('────────────────────────────────────────');
  log.info('[perf] done — see the differences between cold and warm calls.');
  log.info('[perf] If "dv diff <file> (cold)" >> "daemon GET /workspaces", the cost is in dv (binary spawn + daemon round-trip + cloud fetch), not us.');
  log.info('────────────────────────────────────────');
  void vscode.window.showInformationMessage('Diversion: perf trace complete (see Output → Diversion).');
}

async function clearCommitCacheCommand(): Promise<void> {
  if (!commitContent) {
    void vscode.window.showWarningMessage('Diversion: commit content provider not initialised.');
    return;
  }
  const result = await commitContent.clearAll();
  const where = result.cacheDir ? ` at ${result.cacheDir}` : ' (in-memory only — no on-disk cache attached yet)';
  void vscode.window.showInformationMessage(
    `Diversion: cleared ${result.files} cache file(s) (${(result.bytes / 1024).toFixed(1)}KB)${where}`,
  );
}

async function daemonHealthCommand(): Promise<void> {
  const settings = readSettings();
  const daemon = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
  try {
    const health = await daemon.health();
    const url = await daemon.baseUrl();
    const workspaces = await daemon.workspaces();
    const count = Object.keys(workspaces).length;
    const tiers = new Set(Object.values(workspaces).map((w) => w.OrganizationTier));
    void vscode.window.showInformationMessage(
      `Diversion daemon: dv ${health.Version} · ${url} · ${count} workspace(s) registered · tier(s): ${[...tiers].join(', ')}`,
      { modal: false },
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion daemon unreachable: ${(err as Error).message}`);
  }
}

async function verifyCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  try {
    const out = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'dv verify' },
      () => provider.repo.verify(),
    );
    logger?.info(`[verify] ${out.trim()}`);
    void vscode.window.showInformationMessage('Diversion: integrity check complete (see output channel).');
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: verify failed: ${(err as Error).message}`);
  }
}

async function refreshAllCommand(): Promise<void> {
  for (const p of providers.values()) await p.refresh();
  await lockDecorations?.refresh();
  updateStatusBar();
}

// ──────────────────────────── locks ────────────────────────────

async function lockFileCommand(arg?: vscode.Uri | vscode.SourceControlResourceState): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : arg?.resourceUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showInformationMessage('Diversion: open or select a file to lock first.');
    return;
  }
  const provider = providerForUri(uri);
  if (!provider) {
    void vscode.window.showWarningMessage(`Diversion: ${uri.fsPath} is not in a known Diversion workspace.`);
    return;
  }
  const rel = path.relative(provider.repo.root, uri.fsPath);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `dv lock ${rel}` },
      () => provider.repo.lockPath(rel),
    );
    await lockDecorations?.refresh();
    void vscode.window.showInformationMessage(`Locked ${rel}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: lock failed: ${(err as Error).message}`);
  }
}

async function unlockFileCommand(arg?: vscode.Uri | vscode.SourceControlResourceState): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : arg?.resourceUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showInformationMessage('Diversion: open or select a file to unlock first.');
    return;
  }
  const provider = providerForUri(uri);
  if (!provider) return;
  const rel = path.relative(provider.repo.root, uri.fsPath);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `dv lock -d ${rel}` },
      () => provider.repo.unlockPath(rel),
    );
    await lockDecorations?.refresh();
    void vscode.window.showInformationMessage(`Unlocked ${rel}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: unlock failed: ${(err as Error).message}`);
  }
}

async function listLocksCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  let locks;
  try {
    locks = await provider.repo.listLocks();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list locks failed: ${(err as Error).message}`);
    return;
  }
  if (locks.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no active locks.');
    return;
  }
  const items = locks.map((l) => ({
    label: l.path,
    description: l.holder ?? '(unknown holder)',
    detail: l.raw,
    lock: l,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `${locks.length} active lock(s) — pick one to unlock`,
  });
  if (!pick) return;
  try {
    await provider.repo.unlockPath(pick.lock.path);
    await lockDecorations?.refresh();
    void vscode.window.showInformationMessage(`Unlocked ${pick.lock.path}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: unlock failed: ${(err as Error).message}`);
  }
}

// ──────────────────────────── conflicts ────────────────────────────

async function resolveConflictCommand(originalUri?: vscode.Uri, sidecarUri?: vscode.Uri): Promise<void> {
  if (!originalUri || !sidecarUri) {
    void vscode.window.showInformationMessage('Diversion: invoke this command on a conflict in the SCM panel.');
    return;
  }
  const title = `${path.basename(originalUri.fsPath)} (your local ↔ incoming) — edit RIGHT side, then Mark Resolved`;
  await vscode.commands.executeCommand('vscode.diff', sidecarUri, originalUri, title);
}

async function markResolvedCommand(arg?: vscode.Uri | vscode.SourceControlResourceState): Promise<void> {
  const target = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
  if (!target) {
    void vscode.window.showInformationMessage('Diversion: select a conflict in the SCM panel first.');
    return;
  }
  const provider = providerForUri(target);
  if (!provider) return;
  // Find the sidecar by re-running the conflict scan and matching by original path.
  const state = await provider.repo.getState();
  const conflict = state.conflicts.find((c) => c.originalPath === target.fsPath);
  if (!conflict) {
    void vscode.window.showWarningMessage('Diversion: no sync-conflict sidecar found for that file.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete sidecar ${path.basename(conflict.sidecarPath)}? You should have already merged your local changes into the original file before marking resolved.`,
    { modal: true }, 'Delete sidecar',
  );
  if (ok !== 'Delete sidecar') return;
  try {
    await deleteSidecar(conflict.sidecarPath);
    await provider.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: delete sidecar failed: ${(err as Error).message}`);
  }
}

/**
 * Sparkle button next to the commit message input: feeds the unified
 * diff of the working tree (or just the staged paths) to a chat model
 * via `vscode.lm` and writes the result back into the input box.
 *
 * We can't piggyback on the GitHub Copilot extension's own sparkle
 * button — its menu contribution is gated on `scmProvider == git` —
 * so we run our own command that talks to whatever language model the
 * user has registered through `vscode.lm` (Copilot if they have it,
 * any other compatible provider otherwise).
 */
async function generateCommitMessageCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;

  // Prefer Copilot models when available; fall back to whatever the
  // user has so the feature still works for users who've installed a
  // different `vscode.lm` provider.
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) models = await vscode.lm.selectChatModels();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Diversion: language model unavailable — ${(err as Error).message}`,
    );
    return;
  }
  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      'Diversion: no chat model available. Install GitHub Copilot (or another vscode.lm provider) and sign in, then try again.',
    );
    return;
  }
  const model = models[0]!;

  // Match the SCM panel's scope: if the user has staged paths, those win;
  // otherwise, fall back to whatever the panel is *displaying* — i.e. the
  // open-folder-filtered set, not the whole repo. Otherwise a user
  // working in a sub-folder would get a commit message summarising
  // changes elsewhere in the repo that they can't even see.
  const staged = provider.getStagedPaths();
  const scopePaths = staged.length > 0 ? staged : provider.getVisibleChangedPaths();
  if (scopePaths.length === 0) {
    void vscode.window.showWarningMessage(
      'Diversion: nothing to summarise — no changes in the current scope.',
    );
    return;
  }

  let diff: string;
  try {
    diff = await provider.repo.unifiedDiff(scopePaths);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Diversion: dv diff failed — ${(err as Error).message}`,
    );
    return;
  }
  diff = diff.trim();
  if (!diff) {
    void vscode.window.showWarningMessage(
      'Diversion: nothing to summarise — the listed changes produced no diff content.',
    );
    return;
  }

  // Token budgets vary per model; ~100k chars is a safe ceiling that
  // fits even small-context models and keeps the request snappy.
  const MAX_DIFF_CHARS = 100_000;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  const instructions = [
    'You are writing a git commit message for the unified diff below. Output ONLY the message — no markdown fences, no preface, no quotes, no co-author lines, no trailing whitespace.',
    '',
    'FORMAT',
    '1. Subject line: imperative mood, target ≤50 characters, hard limit 72. No trailing period. Use a Conventional Commits prefix when one fits: feat, fix, refactor, perf, docs, test, build, ci, chore — with a parenthesised scope when the change clearly touches one area, e.g. `feat(scope): tighten X`.',
    '2. Blank line separating subject and body.',
    '3. Body (only when it adds value): wrap every line at 72 columns. Explain *why* the change is being made when the diff makes the *what* obvious.',
    '',
    'BODY HYGIENE',
    '- Use `- ` bullet points when listing multiple distinct changes. Never write run-on prose like "Also: ..., ..., ...".',
    '- One idea per paragraph; one item per bullet.',
    '- If the diff bundles clearly unrelated tracks of work, group them under short sub-headings (e.g. a header line ending in `:` followed by bullets) instead of merging them into a single paragraph.',
    '- Skip the body entirely when the subject already conveys everything.',
    '- Prefer specific verbs over vague ones ("rewrite" over "update", "drop" over "change", "scope to" over "limit").',
    '- Do not restate filenames the diff already shows; describe the user-visible behaviour or the engineering rationale.',
  ].join('\n');

  const scopeLabel = staged.length > 0
    ? `${staged.length} staged path(s)`
    : `${scopePaths.length} change(s) in current view`;
  const userPrompt =
    `${instructions}\n\n` +
    `Scope: ${scopeLabel}${truncated ? ' (diff truncated)' : ''}\n\n` +
    '```diff\n' + diff + '\n```';

  const messages = [vscode.LanguageModelChatMessage.User(userPrompt)];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: 'dv: generating commit message' },
    async (_, token) => {
      try {
        const response = await model.sendRequest(messages, {}, token);
        let buf = '';
        for await (const chunk of response.text) {
          if (token.isCancellationRequested) return;
          buf += chunk;
          // Stream into the input box so the user sees the message as
          // it arrives, the same affordance Copilot's git button gives.
          provider.sourceControl.inputBox.value = stripCodeFence(buf).trimStart();
        }
      } catch (err) {
        if (token.isCancellationRequested) return;
        void vscode.window.showErrorMessage(
          `Diversion: commit-message generation failed — ${(err as Error).message}`,
        );
      }
    },
  );
}

/**
 * Some models still wrap their output in a ```...``` fence even when
 * told not to. Strip the leading fence (with optional language tag)
 * and a trailing fence so the input box stays clean.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trimStart();
  const fenceMatch = /^```[^\n]*\n?/.exec(trimmed);
  if (!fenceMatch) return text;
  let stripped = trimmed.slice(fenceMatch[0].length);
  stripped = stripped.replace(/\n?```\s*$/, '');
  return stripped;
}

async function commitCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  const message = provider.sourceControl.inputBox.value.trim();
  if (!message) {
    void vscode.window.showWarningMessage('Diversion: enter a commit message first.');
    return;
  }
  const staged = provider.getStagedPaths();
  const useStaged = staged.length > 0;
  const title = useStaged ? `dv commit (${staged.length} staged)` : 'dv commit -a';
  const beforeCommitId = provider.repo.info.commitId;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title },
      async () => provider.repo.commit(message, useStaged ? staged : undefined),
    );
    provider.clearStaged();
    provider.sourceControl.inputBox.value = '';
    // Wake the agent immediately — the daemon's filesystem watcher
    // would notice the new commit on its own, but a direct nudge
    // shortens the time before /sync reports the new state.
    void provider.repo.notifySyncRequired();
    await waitForNewCommitId(provider, beforeCommitId);
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion commit failed: ${(err as Error).message}`);
  }
}

/**
 * `dv commit` returns as soon as the local op finishes, but the daemon's
 * workspace cache can lag a beat behind reporting the new commit id.
 * Without this wait, the immediate post-commit refresh frequently sees
 * the *old* commit id and the SCM graph + status bar both stay stuck on
 * the previous commit until something else triggers a second refresh.
 *
 * Polls `refreshIdentity()` until the commit id changes (or the budget
 * runs out — the user still gets a refresh, just possibly with stale
 * identity for one cycle).
 */
async function waitForNewCommitId(
  provider: DiversionScmProvider,
  beforeCommitId: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await provider.repo.refreshIdentity();
    if (provider.repo.info.commitId !== beforeCommitId) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ───── staging commands ─────

function relForResource(provider: DiversionScmProvider, uri: vscode.Uri): string {
  // Forward slashes so dv sees a consistent shape on every platform.
  return path.relative(provider.repo.root, uri.fsPath).replace(/\\/g, '/');
}

async function stageCommand(...args: unknown[]): Promise<void> {
  const byProvider = resolveResourceStates(args, 'changes');
  for (const [provider, states] of byProvider) {
    if (states.length === 0) continue;
    provider.stage(states.map((s) => relForResource(provider, s.resourceUri)));
  }
}

async function unstageCommand(...args: unknown[]): Promise<void> {
  const byProvider = resolveResourceStates(args, 'staged');
  for (const [provider, states] of byProvider) {
    if (states.length === 0) continue;
    provider.unstage(states.map((s) => relForResource(provider, s.resourceUri)));
  }
}

/**
 * Resolve whatever VS Code hands a context-menu command into a
 * concrete `Map<provider, SourceControlResourceState[]>`. Handles all
 * three SCM menu surfaces:
 *
 *   - `scm/resourceState/context` — `SourceControlResourceState` per row
 *   - `scm/resourceFolder/context` — a folder `Uri` (tree view); expands
 *     to every file currently displayed under that folder
 *   - `scm/resourceGroup/context` — a group; enumerates `resourceStates`
 *
 * `originGroup` filters the expansion so a "stage" on a folder under
 * the staged group is a no-op rather than re-staging staged files.
 */
function resolveResourceStates(
  args: readonly unknown[],
  originGroup: 'changes' | 'staged',
): Map<DiversionScmProvider, vscode.SourceControlResourceState[]> {
  const byProvider = new Map<DiversionScmProvider, vscode.SourceControlResourceState[]>();
  const seen = new Map<DiversionScmProvider, Set<string>>();
  const push = (provider: DiversionScmProvider, state: vscode.SourceControlResourceState): void => {
    const key = state.resourceUri.fsPath;
    const set = seen.get(provider) ?? new Set<string>();
    if (set.has(key)) return;
    set.add(key); seen.set(provider, set);
    const arr = byProvider.get(provider) ?? [];
    arr.push(state);
    byProvider.set(provider, arr);
  };

  for (const arg of args) {
    if (!arg) continue;
    if (isResourceState(arg)) {
      const provider = providerForUri(arg.resourceUri);
      if (provider) push(provider, arg);
      continue;
    }
    if (arg instanceof vscode.Uri) {
      const provider = providerForUri(arg);
      if (!provider) continue;
      for (const state of statesUnder(provider, arg, originGroup)) push(provider, state);
      continue;
    }
    if (isResourceGroup(arg)) {
      for (const rs of arg.resourceStates) {
        const provider = providerForUri(rs.resourceUri);
        if (provider) push(provider, rs);
      }
      continue;
    }
  }
  return byProvider;
}

function isResourceState(arg: unknown): arg is vscode.SourceControlResourceState {
  return typeof arg === 'object' && arg !== null
    && 'resourceUri' in arg
    && (arg as { resourceUri: unknown }).resourceUri instanceof vscode.Uri;
}

function isResourceGroup(arg: unknown): arg is vscode.SourceControlResourceGroup {
  return typeof arg === 'object' && arg !== null
    && 'resourceStates' in arg
    && Array.isArray((arg as { resourceStates: unknown }).resourceStates);
}

/**
 * Resource states from `provider` whose URI is at or underneath
 * `folderUri`, scoped to the `group` the action originated from.
 * Used to expand folder-row staging / discard actions into the
 * concrete file list the underlying command needs.
 */
function statesUnder(
  provider: DiversionScmProvider,
  folderUri: vscode.Uri,
  group: 'changes' | 'staged',
): vscode.SourceControlResourceState[] {
  const folder = folderUri.fsPath;
  const out: vscode.SourceControlResourceState[] = [];
  for (const state of provider.getResourceStates(group)) {
    if (isInsideOrEqual(folder, state.resourceUri.fsPath)) out.push(state);
  }
  return out;
}

async function stageAllCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  provider.stageAll();
}

async function unstageAllCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  provider.unstageAll();
}

/**
 * Commit only the resources passed in (right-click → "Commit Selected").
 * Uses the SCM input box for the message; falls back to a prompt if empty.
 */
async function commitSelectedCommand(...resources: vscode.SourceControlResourceState[]): Promise<void> {
  if (resources.length === 0) {
    void vscode.window.showWarningMessage('Diversion: select at least one resource to commit.');
    return;
  }
  // All resources should belong to the same provider.
  const provider = providerForUri(resources[0]!.resourceUri);
  if (!provider) return;

  let message = provider.sourceControl.inputBox.value.trim();
  if (!message) {
    const prompt = await vscode.window.showInputBox({
      prompt: `Commit message for ${resources.length} selected resource(s)`,
      placeHolder: 'e.g. fix: tighten input handling',
      validateInput: (v) => v.trim() ? undefined : 'Message required',
    });
    if (!prompt) return;
    message = prompt.trim();
  }

  const paths = resources
    .filter((r) => providerForUri(r.resourceUri) === provider)
    .map((r) => relForResource(provider, r.resourceUri));

  const beforeCommitId = provider.repo.info.commitId;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv commit (${paths.length} path(s))` },
      async () => provider.repo.commit(message, paths),
    );
    provider.sourceControl.inputBox.value = '';
    void provider.repo.notifySyncRequired();
    await waitForNewCommitId(provider, beforeCommitId);
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion commit failed: ${(err as Error).message}`);
  }
}

/**
 * Inline-hover action: open the working file directly (no diff). Accepts
 * either a Uri (when invoked programmatically) or a SourceControlResourceState
 * (when invoked from a context-menu / inline-action contribution).
 */
async function openFileCommand(
  arg?: vscode.Uri | vscode.SourceControlResourceState,
): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : arg?.resourceUri;
  if (!uri) return;
  let isDirectory = false;
  try { isDirectory = (await fs.stat(uri.fsPath)).isDirectory(); } catch {
    // file may not exist (deleted) — fall through and let vscode.open report it
  }
  if (isDirectory) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri);
}

/**
 * Click handler for resources in the SCM panel. Stats the path at click time
 * so directories open the explorer, files open the side-by-side diff (for
 * modified/renamed) or the file directly (for added/deleted).
 */
async function openResourceCommand(uri: vscode.Uri, kind?: ChangeKind): Promise<void> {
  logger?.info(`[click] openResource ${uri.fsPath} kind=${kind ?? '<none>'}`);
  let isDirectory = false;
  try {
    isDirectory = (await fs.stat(uri.fsPath)).isDirectory();
  } catch {
    // File doesn't exist (likely a deletion) — fall through to vscode.open
    // which shows VS Code's standard "file not found" message.
  }

  if (isDirectory) {
    logger?.info(`[click] -> revealInExplorer (directory)`);
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }

  const wantsDiff = kind === 'modified' || kind === 'renamed';
  if (wantsDiff) {
    if (await looksBinary(uri.fsPath)) {
      logger?.info(`[click] -> vscode.open (modified but binary)`);
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    // Disambiguate the diff-editor URI from the gutter-QuickDiff URI by
    // adding a query parameter. Same scheme + same path + different query
    // means VS Code creates a separate TextModel for the diff-editor's
    // left side; otherwise we'd hit "Cannot add model because it already
    // exists" when the QuickDiff for the right-side editor's gutter
    // races with the diff-editor's own setup. Our content provider
    // ignores the query so resolution still works.
    const left = uri.with({ scheme: DV_SCHEME, query: 'view=diff' });
    const title = `${path.basename(uri.fsPath)} (base ↔ Working tree)`;
    logger?.info(`[click] -> vscode.diff left=${left.toString()} right=${uri.toString()}`);
    await vscode.commands.executeCommand('vscode.diff', left, uri, title);
    return;
  }

  logger?.info(`[click] -> vscode.open (added/deleted/etc)`);
  await vscode.commands.executeCommand('vscode.open', uri);
}

async function discardChangesCommand(...args: unknown[]): Promise<void> {
  // Discard only ever runs against unstaged ("changes") rows — staged
  // entries route through unstage first. Expand folder/group args here
  // so a discard click on a tree-view folder catches every file under it.
  const byProvider = resolveResourceStates(args, 'changes');
  const flatResources: vscode.SourceControlResourceState[] = [];
  for (const states of byProvider.values()) flatResources.push(...states);
  if (flatResources.length === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Discard ${flatResources.length} file(s)? This cannot be undone.`,
    { modal: true }, 'Discard',
  );
  if (confirm !== 'Discard') return;

  const touched = new Set<DiversionScmProvider>();
  for (const r of flatResources) {
    const provider = providerForUri(r.resourceUri);
    if (!provider) continue;
    try {
      // Discard semantics differ by kind, just like git:
      //  - added (untracked) → delete the file from disk; `dv reset` has
      //    no useful effect for paths that aren't yet committed
      //  - modified / deleted / renamed → `dv reset -f` returns the file
      //    to its base-commit state
      const ctx = r.contextValue ?? '';
      const isAdded = ctx === 'unstaged-added' || ctx === 'staged-added';
      if (isAdded) {
        await fs.rm(r.resourceUri.fsPath, { recursive: true, force: true });
      } else {
        // Path must be relative to the repo root, not the open workspace
        // folder. When the user opens a sub-directory of the repo,
        // workspace.asRelativePath returns a path relative to that
        // sub-folder — `dv reset` then sees a non-existent path and
        // silently no-ops. relForResource resolves against repo.root so
        // dv sees the canonical Documentation/nod.md form regardless of
        // which sub-folder VS Code thinks the user is in.
        const relative = relForResource(provider, r.resourceUri);
        await provider.repo.discardPath(relative);
      }
      touched.add(provider);
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion discard failed: ${(err as Error).message}`);
    }
  }
  for (const p of touched) await p.refresh();
}

async function discardAllCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  const confirm = await vscode.window.showWarningMessage(
    'Discard ALL uncommitted changes? This cannot be undone.',
    { modal: true }, 'Discard All', 'Discard All (incl. new files)',
  );
  if (!confirm) return;
  const includeNew = confirm === 'Discard All (incl. new files)';
  try {
    await provider.repo.discardAll(includeNew);
    await provider.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion discard-all failed: ${(err as Error).message}`);
  }
}

async function openInWebCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  try {
    await provider.repo.openInWeb();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: open-in-web failed: ${(err as Error).message}`);
  }
}

async function viewHistoryCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  try {
    const commits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Diversion: loading history…' },
      () => provider.repo.logFull(50),
    );
    showLogWebview(provider.repo.info.repoName, commits);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: load history failed: ${(err as Error).message}`);
  }
}

async function cherryPickCommand(commitId?: string): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitId, 'Cherry-pick which commit?');
  if (!id) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv cherry-pick ${id}` },
      () => provider.repo.cherryPick(id),
    );
    await provider.refresh();
    updateStatusBar();
    void vscode.window.showInformationMessage(`Cherry-picked ${id}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: cherry-pick failed: ${(err as Error).message}`);
  }
}

async function revertCommitCommand(commitId?: string): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitId, 'Revert which commit?');
  if (!id) return;
  const ok = await vscode.window.showWarningMessage(
    `Create a new commit that inverts ${id}?`,
    { modal: true }, 'Revert',
  );
  if (ok !== 'Revert') return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv revert ${id}` },
      () => provider.repo.revertCommit(id),
    );
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: revert failed: ${(err as Error).message}`);
  }
}

async function revertToCommitCommand(commitId?: string): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitId, 'Restore workspace to which commit?');
  if (!id) return;
  const ok = await vscode.window.showWarningMessage(
    `Set the workspace contents to match ${id}? Local uncommitted changes may be lost. (No history is rewritten — the result will be saved as workspace changes you can then commit.)`,
    { modal: true }, 'Restore To',
  );
  if (ok !== 'Restore To') return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv revert-to-commit ${id}` },
      () => provider.repo.revertToCommit(id),
    );
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: restore failed: ${(err as Error).message}`);
  }
}

// ───── shelves ─────

async function createShelfCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const name = await vscode.window.showInputBox({
    prompt: 'Shelf name',
    placeHolder: 'e.g. wip-inventory-ui',
    validateInput: (s) => s.trim() ? undefined : 'Name required',
  });
  if (!name) return;
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Shelve & reset workspace (default)', detail: 'Workspace returns to base; shelf holds your changes', keep: false },
      { label: 'Shelve & keep working changes', detail: '--no-reset (the changes stay in the workspace too)', keep: true },
    ],
    { placeHolder: 'How should the workspace be left after shelving?' },
  );
  if (!choice) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv shelf create ${name.trim()}` },
      () => provider.repo.createShelf(name.trim(), undefined, choice.keep),
    );
    shelvesProvider?.refresh();
    await provider.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: shelf create failed: ${(err as Error).message}`);
  }
}

async function applyShelfCommand(node?: ShelfNode): Promise<void> {
  const target = await pickShelfFromNodeOrPrompt(node, 'Apply which shelf?');
  if (!target) return;
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Apply and delete (default)', detail: 'Shelf is removed after applying', keep: false },
      { label: 'Apply and keep', detail: '--keep (shelf stays after applying)', keep: true },
    ],
    { placeHolder: 'Apply mode' },
  );
  if (!choice) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv shelf apply ${target.shelf}` },
      () => target.repo.applyShelf(target.shelf, choice.keep),
    );
    shelvesProvider?.refresh();
    for (const p of providers.values()) await p.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: shelf apply failed: ${(err as Error).message}`);
  }
}

async function deleteShelfCommand(node?: ShelfNode): Promise<void> {
  const target = await pickShelfFromNodeOrPrompt(node, 'Delete which shelf?');
  if (!target) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete shelf "${target.shelf}"? This cannot be undone.`,
    { modal: true }, 'Delete',
  );
  if (ok !== 'Delete') return;
  try {
    await target.repo.deleteShelf(target.shelf);
    shelvesProvider?.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: shelf delete failed: ${(err as Error).message}`);
  }
}

async function renameShelfCommand(node?: ShelfNode): Promise<void> {
  const target = await pickShelfFromNodeOrPrompt(node, 'Rename which shelf?');
  if (!target) return;
  const newName = await vscode.window.showInputBox({
    prompt: 'New shelf name',
    value: target.shelf,
    validateInput: (s) => s.trim() ? undefined : 'Name required',
  });
  if (!newName || newName.trim() === target.shelf) return;
  try {
    await target.repo.renameShelf(target.shelf, newName.trim());
    shelvesProvider?.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: shelf rename failed: ${(err as Error).message}`);
  }
}

async function shelveAndSwitchBranchCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  let branches;
  try {
    branches = await provider.repo.listBranches();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list branches failed: ${(err as Error).message}`);
    return;
  }
  const current = provider.repo.info.branchName;
  const items = branches
    .filter((b) => b.name !== current)
    .map((b) => ({ label: b.name, description: b.commitId, detail: b.id, branchName: b.name }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no other branches to switch to.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Shelve current changes and switch from ${current} to…`,
  });
  if (!pick) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv checkout --shelve-changes ${pick.branchName}` },
      () => provider.repo.checkout(pick.branchName, { shelveChanges: true }),
    );
    shelvesProvider?.refresh();
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: shelve-and-switch failed: ${(err as Error).message}`);
  }
}

interface ShelfTarget {
  shelf: string;
  repo: import('./diversion/repo.js').Repo;
}

async function pickShelfFromNodeOrPrompt(node: ShelfNode | undefined, prompt: string): Promise<ShelfTarget | undefined> {
  if (node && node.kind === 'shelf') {
    return { shelf: node.shelf.id ?? node.shelf.name, repo: node.repo };
  }
  const provider = activeProvider();
  if (!provider) return undefined;
  let shelves;
  try {
    shelves = await provider.repo.listShelves();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list shelves failed: ${(err as Error).message}`);
    return undefined;
  }
  if (shelves.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no shelves to choose from.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    shelves.map((s) => ({ label: s.name, description: s.id, detail: s.description, shelf: s })),
    { placeHolder: prompt },
  );
  if (!pick) return undefined;
  return { shelf: pick.shelf.id ?? pick.shelf.name, repo: provider.repo };
}

async function ensureCommitId(provided: string | undefined, prompt: string): Promise<string | undefined> {
  if (provided) return provided;
  const v = await vscode.window.showInputBox({
    prompt,
    placeHolder: 'e.g. dv.commit.42',
    validateInput: (s) => /^dv\.commit\.[\w-]+$/.test(s.trim()) ? undefined : 'Expected a commit ID like "dv.commit.42"',
  });
  return v?.trim();
}

async function switchBranchCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) {
    void vscode.window.showInformationMessage('Diversion: no active workspace.');
    return;
  }
  let branches: Awaited<ReturnType<typeof provider.repo.listBranches>>;
  try {
    branches = await provider.repo.listBranches();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list branches failed: ${(err as Error).message}`);
    return;
  }
  const current = provider.repo.info.branchName;
  const items = branches.map((b) => ({
    label: b.name === current ? `$(check) ${b.name}` : b.name,
    description: b.commitId,
    detail: b.id,
    branchName: b.name,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Current: ${current} — pick a branch to switch to`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick || pick.branchName === current) return;

  const handling = await vscode.window.showQuickPick(
    [
      { label: 'Take changes', detail: '--take-changes (carry uncommitted edits to the new branch)', action: 'take' as const },
      { label: 'Shelve changes', detail: '--shelve-changes (set aside uncommitted edits)', action: 'shelve' as const },
      { label: 'Discard changes', detail: '--discard-changes (throw away uncommitted edits — irreversible)', action: 'discard' as const },
    ],
    { placeHolder: 'How to handle uncommitted changes?' },
  );
  if (!handling) return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv checkout ${pick.branchName}` },
      () => provider.repo.checkout(pick.branchName, {
        takeChanges: handling.action === 'take',
        shelveChanges: handling.action === 'shelve',
        discardChanges: handling.action === 'discard',
      }),
    );
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion checkout failed: ${(err as Error).message}`);
  }
}

async function createBranchCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const name = await vscode.window.showInputBox({
    prompt: 'New branch name',
    validateInput: (v) => v.trim() ? undefined : 'Name required',
  });
  if (!name) return;
  try {
    await provider.repo.createBranch(name.trim(), true);
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: create branch failed: ${(err as Error).message}`);
  }
}

async function mergeCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  let branches: Awaited<ReturnType<typeof provider.repo.listBranches>>;
  try {
    branches = await provider.repo.listBranches();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list branches failed: ${(err as Error).message}`);
    return;
  }
  const current = provider.repo.info.branchName;
  const items = branches
    .filter((b) => b.name !== current)
    .map((b) => ({
      label: b.name,
      description: b.commitId,
      detail: b.id,
      branchName: b.name,
    }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no other branches to merge.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Merge into ${current} from…`,
  });
  if (!pick) return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv merge ${pick.branchName}` },
      () => provider.repo.merge(pick.branchName),
    );
    await provider.refresh();
    updateStatusBar();
    void vscode.window.showInformationMessage(`Merged ${pick.branchName} into ${current}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Diversion: merge failed (conflicts may need resolving in the web UI): ${(err as Error).message}`,
    );
  }
}

function pickProvider(sc?: vscode.SourceControl): DiversionScmProvider | undefined {
  if (sc) {
    for (const p of providers.values()) if (p.sourceControl === sc) return p;
  }
  return activeProvider();
}

function providerForUri(uri: vscode.Uri): DiversionScmProvider | undefined {
  for (const [root, p] of providers) {
    if (isInsideOrEqual(root, uri.fsPath)) return p;
  }
  return undefined;
}

/**
 * Common path for "the user just touched a file in the editor" events.
 * Schedules an immediate SCM refresh, invalidates per-file caches,
 * and nudges the local agent so its sync state catches up promptly.
 *
 * The FS watcher path still fires for the same change, but it lags
 * VS Code's editor events and goes through a (configurable) debounce —
 * routing editor-originated events here gives the SCM panel a within-
 * a-frame response instead of waiting on the watcher.
 */
function onDocumentMutated(uri: vscode.Uri): void {
  if (uri.scheme !== 'file') return;
  const provider = providerForUri(uri);
  if (!provider) return;
  // Zero-debounce refresh: scheduleRefresh's coalescing + the in-flight
  // queue in DiversionScmProvider.refresh() prevent dv-storming when
  // the user saves rapidly.
  provider.scheduleRefresh(0);
  commitContent?.invalidate(uri.fsPath);
  // Best-effort: wake the agent to re-scan so /sync reflects the new
  // state without waiting on its own filesystem-watch poll.
  void provider.repo.notifySyncRequired();
}
