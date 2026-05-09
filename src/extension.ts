import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Logger } from './util/log.js';
import { DaemonClient, DaemonUnavailableError } from './diversion/daemon.js';
import { detectRepo } from './diversion/detect.js';
import { Repo } from './diversion/repo.js';
import { readSettings } from './diversion/settings.js';
import { DiversionScmProvider } from './scm/provider.js';
import { QuickDiff, DV_SCHEME } from './scm/quickDiff.js';
import { CommitContentProvider, DV_COMMIT_SCHEME } from './scm/commitContent.js';
import { LockDecorationProvider } from './scm/lockDecorations.js';
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
let blame: Blame | undefined;
let shelvesProvider: ShelvesTreeProvider | undefined;
let commitContent: CommitContentProvider | undefined;
const providers = new Map<string, DiversionScmProvider>();
let activationContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationContext = context;
  logger = new Logger();
  const log = logger;
  // Surface the channel immediately so users see *something* even if scan fails.
  log.show();
  const folders = vscode.workspace.workspaceFolders ?? [];
  log.info(`Diversion extension activating; ${folders.length} workspace folder(s):`);
  for (const f of folders) log.info(`  • ${f.uri.fsPath}`);

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
  };
  quickDiff = new QuickDiff(repoLookup, log);
  commitContent = new CommitContentProvider(repoLookup, log);

  lockDecorations = new LockDecorationProvider(
    () => [...providers.values()].map((p) => p.repo),
    log,
  );
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
    blame,
    vscode.workspace.registerTextDocumentContentProvider(DV_SCHEME, quickDiff),
    vscode.workspace.registerTextDocumentContentProvider(DV_COMMIT_SCHEME, commitContent),
    vscode.window.registerFileDecorationProvider(lockDecorations),
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

  await healthCheck(log);
  await scanWorkspaceFolders();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void scanWorkspaceFolders(); }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) for (const p of providers.values()) p.scheduleRefresh(50);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
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
  const seen = new Set<string>();

  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') continue;
    const fsPath = folder.uri.fsPath;
    seen.add(fsPath);
    if (providers.has(fsPath)) continue;

    try {
      log.info(`Scanning ${fsPath} for a Diversion workspace…`);
      const id = await detectRepo(daemon, fsPath);
      if (!id) {
        log.info(`  ↳ no .diversion/ marker (or no daemon match) under ${fsPath}`);
        continue;
      }

      const repo = new Repo(daemon, id, settings.dvPath, log);
      const provider = new DiversionScmProvider(
        repo, log, activationContext!.workspaceState, quickDiff, commitContent,
      );
      providers.set(fsPath, provider);
      log.info(`Registered SCM provider for ${id.repoName} on ${id.branchName || '<unknown branch>'} (${id.commitId || '<no commit>'}) at ${fsPath}`);

      provider.scheduleRefresh(0);
      const watcherDisposable = watchWorkspace(fsPath, (uri) => {
        provider.scheduleRefresh(settings.refreshDebounceMs);
        // Lock state can change as a side-effect of edits (auto-lock on
        // edit) — bust the cache and let decorations refresh too.
        void lockDecorations?.refresh();
        // Working file changed → cached commit-content is stale because
        // we anchor reverse-apply on the working contents.
        commitContent?.invalidate(uri.fsPath);
      });
      activationContext?.subscriptions.push(watcherDisposable);
    } catch (err) {
      log.error(`Detection/registration failed for ${fsPath}`, err);
    }
  }

  for (const [key, provider] of [...providers.entries()]) {
    if (!seen.has(key)) {
      provider.dispose();
      providers.delete(key);
      log.info(`Removed SCM provider for ${key}`);
    }
  }

  await vscode.commands.executeCommand('setContext', 'diversion.hasRepo', providers.size > 0);
  updateStatusBar();
}

function updateStatusBar(): void {
  if (!statusBar) return;
  const provider = activeProvider();
  statusBar.update(provider?.repo);
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
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title },
      async () => provider.repo.commit(message, useStaged ? staged : undefined),
    );
    provider.clearStaged();
    provider.sourceControl.inputBox.value = '';
    await provider.refresh();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion commit failed: ${(err as Error).message}`);
  }
}

// ───── staging commands ─────

function relForResource(provider: DiversionScmProvider, uri: vscode.Uri): string {
  // Forward slashes so dv sees a consistent shape on every platform.
  return path.relative(provider.repo.root, uri.fsPath).replace(/\\/g, '/');
}

async function stageCommand(...resources: vscode.SourceControlResourceState[]): Promise<void> {
  await routeStaging(resources, (provider, paths) => provider.stage(paths));
}

async function unstageCommand(...resources: vscode.SourceControlResourceState[]): Promise<void> {
  await routeStaging(resources, (provider, paths) => provider.unstage(paths));
}

async function routeStaging(
  resources: vscode.SourceControlResourceState[],
  apply: (provider: DiversionScmProvider, paths: string[]) => void,
): Promise<void> {
  if (resources.length === 0) return;
  const byProvider = new Map<DiversionScmProvider, string[]>();
  for (const r of resources) {
    const provider = providerForUri(r.resourceUri);
    if (!provider) continue;
    const arr = byProvider.get(provider) ?? [];
    arr.push(relForResource(provider, r.resourceUri));
    byProvider.set(provider, arr);
  }
  for (const [provider, paths] of byProvider) apply(provider, paths);
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
    .map((r) => vscode.workspace.asRelativePath(r.resourceUri, false).replace(/\\/g, '/'));

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv commit (${paths.length} path(s))` },
      async () => provider.repo.commit(message, paths),
    );
    provider.sourceControl.inputBox.value = '';
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
    const left = uri.with({ scheme: DV_SCHEME });
    const title = `${path.basename(uri.fsPath)} (base ↔ Working tree)`;
    logger?.info(`[click] -> vscode.diff left=${left.toString()} right=${uri.toString()}`);
    await vscode.commands.executeCommand('vscode.diff', left, uri, title);
    return;
  }

  logger?.info(`[click] -> vscode.open (added/deleted/etc)`);
  await vscode.commands.executeCommand('vscode.open', uri);
}

async function discardChangesCommand(...resources: vscode.SourceControlResourceState[]): Promise<void> {
  if (resources.length === 0) return;
  const confirm = await vscode.window.showWarningMessage(
    `Discard ${resources.length} file(s)? This cannot be undone.`,
    { modal: true }, 'Discard',
  );
  if (confirm !== 'Discard') return;

  const touched = new Set<DiversionScmProvider>();
  for (const r of resources) {
    const provider = providerForUri(r.resourceUri);
    if (!provider) continue;
    try {
      const relative = vscode.workspace.asRelativePath(r.resourceUri, false).replace(/\\/g, '/');
      await provider.repo.discardPath(relative);
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
