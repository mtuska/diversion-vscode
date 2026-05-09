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
import { LockDecorationProvider } from './scm/lockDecorations.js';
import { Blame } from './scm/blame.js';
import { watchWorkspace } from './util/fsWatch.js';
import { StatusBar } from './ui/statusBar.js';
import { showLogWebview } from './ui/webviews/log.js';
import { GraphWebview } from './ui/webviews/graph.js';
import { looksBinary } from './util/binary.js';
import { deleteSidecar } from './diversion/repo.js';
import type { ChangeKind } from './diversion/types.js';

let logger: Logger | undefined;
let statusBar: StatusBar | undefined;
let quickDiff: QuickDiff | undefined;
let lockDecorations: LockDecorationProvider | undefined;
let blame: Blame | undefined;
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
  quickDiff = new QuickDiff(
    {
      rootForPath: (fsPath: string) => {
        for (const [root, p] of providers) {
          if (fsPath.startsWith(root + '/') || fsPath === root) {
            return { root, dvPath: p.repo.binaryPath };
          }
        }
        return undefined;
      },
    },
    log,
  );

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

  context.subscriptions.push(
    statusBar,
    quickDiff,
    lockDecorations,
    blame,
    vscode.workspace.registerTextDocumentContentProvider(DV_SCHEME, quickDiff),
    vscode.window.registerFileDecorationProvider(lockDecorations),
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
    vscode.commands.registerCommand('diversion.showGraph', showGraphCommand),
    vscode.commands.registerCommand('diversion.cherryPickCommit', cherryPickCommand),
    vscode.commands.registerCommand('diversion.revertCommit', revertCommitCommand),
    vscode.commands.registerCommand('diversion.revertToCommit', revertToCommitCommand),
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
      const provider = new DiversionScmProvider(repo, log, activationContext!.workspaceState, quickDiff);
      providers.set(fsPath, provider);
      log.info(`Registered SCM provider for ${id.repoName} on ${id.branchName || '<unknown branch>'} (${id.commitId || '<no commit>'}) at ${fsPath}`);

      provider.scheduleRefresh(0);
      const watcherDisposable = watchWorkspace(fsPath, () => {
        provider.scheduleRefresh(settings.refreshDebounceMs);
        // Lock state can change as a side-effect of edits (auto-lock on
        // edit) — bust the cache and let decorations refresh too.
        void lockDecorations?.refresh();
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
      if (editor.document.uri.fsPath.startsWith(root)) return p;
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
    { label: '$(git-commit) Show Graph', command: 'diversion.showGraph' },
    { label: '$(history) View History', command: 'diversion.viewHistory' },
    { label: '$(globe) Open in Web UI', command: 'diversion.openInWeb' },
    { label: '$(eye) Toggle Blame (Annotation)', command: 'diversion.toggleBlame' },
    { label: '$(verified) Verify Repository Integrity', command: 'diversion.verify' },
    { label: '$(server) Show Daemon Health', command: 'diversion.daemonHealth' },
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
  return path.relative(provider.repo.root, uri.fsPath);
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
    .map((r) => vscode.workspace.asRelativePath(r.resourceUri, false));

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
      const relative = vscode.workspace.asRelativePath(r.resourceUri, false);
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

const graphWebviews = new Map<string, GraphWebview>();

async function showGraphCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) {
    void vscode.window.showInformationMessage('Diversion: no active workspace.');
    return;
  }
  const root = provider.repo.root;
  let view = graphWebviews.get(root);
  if (!view) {
    view = new GraphWebview(provider.repo, logger!);
    graphWebviews.set(root, view);
    activationContext?.subscriptions.push(view);
  }
  try {
    await view.show();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: graph failed: ${(err as Error).message}`);
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
    if (uri.fsPath.startsWith(root)) return p;
  }
  return undefined;
}
