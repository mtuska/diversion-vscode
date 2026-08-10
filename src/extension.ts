import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Logger } from './util/log.js';
import { DaemonClient, DaemonUnavailableError } from './diversion/daemon.js';
import { detectRepo, findDiversionRoot, findNestedDiversionRoots } from './diversion/detect.js';
import { Repo, MAX_COMMIT_MESSAGE_LEN } from './diversion/repo.js';
import { readSettings } from './diversion/settings.js';
import { setDvConcurrencyLimit, setOnDvMissing } from './diversion/cli.js';
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
import { buildConflictText, hasConflictMarkers } from './diversion/mergeMarkers.js';
import type { ChangeKind, OpenMerge } from './diversion/types.js';
import { registerLanguageModelTools } from './ai/tools.js';

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
/**
 * FS watchers keyed by repo root. Owned here (not pushed into
 * `context.subscriptions`) so a re-scan can dispose the previous set instead
 * of stacking a fresh recursive watcher on top for every open folder each time
 * `scanWorkspaceFolders` runs — which previously leaked watchers on daemon
 * reconnect / folder change and kept firing refreshes for removed repos.
 */
const repoWatchers = new Map<string, vscode.Disposable[]>();

function disposeRepoWatchers(root: string): void {
  const existing = repoWatchers.get(root);
  if (existing) {
    for (const d of existing) d.dispose();
    repoWatchers.delete(root);
  }
}
let activationContext: vscode.ExtensionContext | undefined;
/** Whether the "dv binary not found" toast has been shown this session. Reset on `diversion.path` change. */
let dvMissingNotified = false;

/**
 * One-shot, actionable error toast for the `spawn dv ENOENT` case (binary
 * not on PATH, or `diversion.path` set to something that doesn't exist).
 * Without this the user only sees the SCM panel quietly empty — every
 * refresh/lock/QuickDiff call logs an error and they have no UI cue.
 *
 * Subsequent ENOENT events are silently dropped until the user updates
 * `diversion.path` (which resets `dvMissingNotified`).
 */
function notifyDvMissing(attemptedPath: string): void {
  if (dvMissingNotified) return;
  dvMissingNotified = true;
  const configured = vscode.workspace.getConfiguration('diversion').get<string>('path', '').trim();
  const detail = configured
    ? `Configured \`diversion.path\` is \`${configured}\` but no executable was found there.`
    : `\`dv\` is not on the extension host's PATH (tried \`${attemptedPath}\`). ` +
      `This commonly happens when VS Code is launched from a desktop launcher whose PATH ` +
      `doesn't include where \`dv\` lives (e.g. \`~/.local/bin\`, \`~/.diversion/bin\`).`;
  const message = `Diversion: cannot find the \`dv\` CLI. SCM operations will fail until this is resolved.`;
  void vscode.window.showErrorMessage(
    `${message} ${detail}`,
    'Set Path…',
    'Open Settings',
    'Show Output',
  ).then((pick) => {
    if (pick === 'Set Path…') void promptForDvPath();
    else if (pick === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'diversion.path');
    } else if (pick === 'Show Output') logger?.show();
  });
  logger?.error(`[cli] dv binary not found (attempted: ${attemptedPath}). User notified.`);
}

async function promptForDvPath(): Promise<void> {
  const current = vscode.workspace.getConfiguration('diversion').get<string>('path', '');
  const value = await vscode.window.showInputBox({
    title: 'Diversion: path to the `dv` binary',
    prompt: 'Absolute path, or leave empty to use the system PATH lookup.',
    value: current,
    placeHolder: process.platform === 'win32'
      ? 'e.g. C:\\Program Files\\Diversion\\dv.exe'
      : 'e.g. /home/<you>/.local/bin/dv',
  });
  if (value === undefined) return;
  await vscode.workspace.getConfiguration('diversion').update(
    'path',
    value.trim() || undefined,
    vscode.ConfigurationTarget.Global,
  );
  // The config-change listener flips dvMissingNotified back to false, so
  // a still-broken value will surface a fresh toast on the next dv call.
  // Kick a refresh to confirm the new path works (or re-trigger the toast).
  for (const p of providers.values()) p.scheduleRefresh(0);
}

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
          return { root, dvPath: p.repo.binaryPath, commitId: p.repo.info.commitId };
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
    vscode.commands.registerCommand('diversion.commitToNewBranch', commitToNewBranchCommand),
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
    vscode.commands.registerCommand('diversion.showOpenMerges', showOpenMergesCommand),
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
    vscode.commands.registerCommand('diversion.copyCommitId', copyCommitIdCommand),
    vscode.commands.registerCommand('diversion.copyCommitMessage', copyCommitMessageCommand),
    vscode.commands.registerCommand('diversion.createTagAtCommit', createTagAtCommitCommand),
    vscode.commands.registerCommand('diversion.manageTags', manageTagsCommand),
    vscode.commands.registerCommand('diversion.compareWithCommit', compareWithCommitCommand),
    vscode.commands.registerCommand('diversion.openCommitInWeb', openCommitInWebCommand),
    vscode.commands.registerCommand('diversion.checkoutBranchAtCommit', checkoutBranchAtCommitCommand),
    vscode.commands.registerCommand('diversion.refreshShelves', () => shelvesProvider?.refresh()),
    vscode.commands.registerCommand('diversion.createShelf', createShelfCommand),
    vscode.commands.registerCommand('diversion.applyShelf', applyShelfCommand),
    vscode.commands.registerCommand('diversion.deleteShelf', deleteShelfCommand),
    vscode.commands.registerCommand('diversion.renameShelf', renameShelfCommand),
    vscode.commands.registerCommand('diversion.shelveAndSwitchBranch', shelveAndSwitchBranchCommand),
  );

  // Expose read-only SCM state to Copilot Chat / other vscode.lm consumers.
  registerLanguageModelTools(
    context,
    function* () { for (const p of providers.values()) yield p.repo; },
    log,
  );

  // Apply concurrency cap before any dv calls fire.
  setDvConcurrencyLimit(readSettings().maxParallelProcesses);
  setOnDvMissing((info) => notifyDvMissing(info.dvPath));

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
      if (e.affectsConfiguration('diversion.path')) {
        // Propagate the new path to every existing Repo — they captured
        // the old value at construction, so without this the change has
        // no effect until window reload.
        const next = readSettings().dvPath;
        for (const p of providers.values()) p.repo.setBinaryPath(next);
        // Allow the missing-binary toast to fire again so the user gets
        // feedback if the new value still doesn't work.
        dvMissingNotified = false;
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
  for (const root of [...repoWatchers.keys()]) disposeRepoWatchers(root);
  for (const p of providers.values()) p.dispose();
  providers.clear();
  statusBar?.dispose();
  quickDiff?.dispose();
}

let reconnectTimer: NodeJS.Timeout | undefined;
let daemonConnected = false;

async function healthCheck(log: Logger): Promise<void> {
  const settings = readSettings();
  const daemon = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
  try {
    const health = await daemon.health();
    onDaemonReady(log, daemon, health.Version);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      log.warn(`Daemon unreachable: ${err.message}. Filesystem fallback in use; will retry in the background.`);
      scheduleDaemonReconnect(log);
    } else {
      log.error('Unexpected error contacting daemon', err);
    }
  }
}

function onDaemonReady(log: Logger, daemon: DaemonClient, version: string): void {
  daemonConnected = true;
  void daemon.baseUrl().then((url) => log.info(`Daemon healthy at ${url} (dv ${version})`));
  warnIfIncompatibleVersion(log, version);
  // Wire up the persistent commit-content cache once we know dv's version.
  // Cache is segmented by version so old-version artifacts don't leak in.
  if (commitContent && activationContext) {
    commitContent.attachPersistence(activationContext.globalStorageUri, version);
  }
}

/**
 * Background poll for the daemon when it's down at activation. Without this,
 * a user who launches VS Code before `dv` finishes starting up gets stuck on
 * the filesystem-fallback identity for the rest of the session — no graph,
 * no commit-content cache, no live sync state. Polls every 5s for the first
 * minute, then every 30s indefinitely; cancelled when the daemon answers or
 * when the extension deactivates.
 */
function scheduleDaemonReconnect(log: Logger): void {
  if (reconnectTimer || daemonConnected) return;
  let attempt = 0;
  const tick = async (): Promise<void> => {
    if (daemonConnected) return;
    attempt += 1;
    const settings = readSettings();
    const daemon = new DaemonClient(settings.daemonUrl ? { baseUrl: settings.daemonUrl } : {});
    try {
      const health = await daemon.health();
      reconnectTimer = undefined;
      log.info(`Daemon reachable after ${attempt} retr${attempt === 1 ? 'y' : 'ies'} — completing setup.`);
      onDaemonReady(log, daemon, health.Version);
      // Re-scan in case no providers registered earlier (e.g. detection
      // needed the daemon to disambiguate path → workspace mappings).
      void scanWorkspaceFolders();
      // Refresh existing providers so their identity (branch/commit) and
      // graph upgrade from the filesystem-only fallback to daemon truth.
      for (const p of providers.values()) p.scheduleRefresh(0);
      updateStatusBar();
      return;
    } catch (err) {
      if (!(err instanceof DaemonUnavailableError)) {
        log.error('Unexpected error during daemon reconnect', err);
      }
    }
    const delayMs = attempt < 12 ? 5_000 : 30_000;
    reconnectTimer = setTimeout(() => { void tick(); }, delayMs);
  };
  reconnectTimer = setTimeout(() => { void tick(); }, 5_000);
  activationContext?.subscriptions.push({
    dispose: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    },
  });
}

/**
 * Warn (once) if the running `dv` is on a different *major* version than what
 * we tested against. We test against dv v1.0.x (specifically v1.0.40); dv
 * follows semver post-1.0, so the whole 1.x line is treated as compatible and
 * only a different major triggers the notice. We never refuse to activate —
 * this is a soft compatibility check, and most reads now go through the
 * version-stable CoreAPI rather than CLI text parsing.
 */
function warnIfIncompatibleVersion(log: Logger, version: string): void {
  // Strip leading 'v' and parse first three numbers.
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    log.warn(`Could not parse dv version "${version}" — proceeding without compat check.`);
    return;
  }
  const major = Number.parseInt(m[1]!, 10);

  // Tested band: dv 1.0.x. Post-1.0 the major version is the breaking-change
  // axis, so any 1.x minor/patch is considered fine.
  const testedMajor = 1;
  const testedMinor = 0;
  if (major === testedMajor) return;

  const direction = major > testedMajor ? 'newer' : 'older';
  const msg = `Diversion: this extension was tested against dv ${testedMajor}.${testedMinor}.x — you have ${version} (${direction}). Some operations may be off; report any glitches.`;
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
      const repo = new Repo(daemon, id, settings.dvPath, log, settings.coreApiUrl);
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
    // provider — refresh fires regardless of which folder the change came
    // from. Rebuild the set each scan (open folders may have changed),
    // disposing the prior set first so watchers don't accumulate.
    disposeRepoWatchers(root);
    const ignoreMgrForRoot = ignoreManagers.get(root);
    const watchers = openFolders.map((folderPath) =>
      watchWorkspace(folderPath, async (uri) => {
        // A `.dv-conflict` sidecar appearing/disappearing is the only thing
        // that changes the conflict set — invalidate the (otherwise cached,
        // walk-backed) conflict list so the next refresh re-scans.
        if (uri.fsPath.includes('.dv-conflict')) provider!.repo.invalidateConflictCache();
        provider!.scheduleRefresh(settings.refreshDebounceMs);
        // NOTE: locks are deliberately NOT refreshed here. Locks change via
        // lock/unlock commands (which force a refresh) and the provider's own
        // 5s TTL + on-demand fetch — refreshing on every file write thrashed
        // the lock cache and fired a whole-window decoration invalidation per
        // event, which on a large sync meant tens of thousands of re-queries.
        commitContent?.invalidate(uri.fsPath);
        // If a .dvignore / .gitignore file changed, reload the matcher
        // and re-fire decorations across the whole repo.
        if (ignoreMgrForRoot) {
          const reloaded = await ignoreMgrForRoot.maybeReload(uri.fsPath);
          if (reloaded) changeDecorations?.refresh();
        }
      }),
    );
    repoWatchers.set(root, watchers);
  }

  for (const [key, provider] of [...providers.entries()]) {
    if (!foldersByRoot.has(key)) {
      disposeRepoWatchers(key);
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
    { label: '$(git-pull-request) Show Unresolved Merges…', command: 'diversion.showOpenMerges' },
    sep('Sync'),
    { label: '$(sync) Update Workspace', command: 'diversion.updateWorkspace' },
    { label: '$(debug-pause) Pause Sync', command: 'diversion.pauseSync' },
    { label: '$(debug-continue) Resume Sync', command: 'diversion.resumeSync' },
    sep('Locks'),
    { label: '$(lock) Lock File', command: 'diversion.lockFile' },
    { label: '$(unlock) Unlock File', command: 'diversion.unlockFile' },
    { label: '$(list-tree) List Locks…', command: 'diversion.listLocks' },
    sep('Tags'),
    { label: '$(tag) Manage Tags…', command: 'diversion.manageTags' },
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

/**
 * Resolve a sync conflict block by block.
 *
 * The two versions are both already on disk — the sidecar holds your local
 * copy and the agent overwrote the original with the incoming one. We diff
 * them, write the differing regions back into the original as standard
 * conflict markers, and open it. VS Code's built-in Merge Conflict extension
 * then renders Accept Current / Accept Incoming / Accept Both / Compare above
 * every block, which is the per-block decision we want to offer and costs us
 * no UI of our own.
 *
 * Binary files can't be marked up, so they keep the side-by-side view.
 */
async function resolveConflictCommand(originalUri?: vscode.Uri, sidecarUri?: vscode.Uri): Promise<void> {
  if (!originalUri || !sidecarUri) {
    void vscode.window.showInformationMessage('Diversion: invoke this command on a conflict in the SCM panel.');
    return;
  }
  const name = path.basename(originalUri.fsPath);

  if (await looksBinary(originalUri.fsPath) || await looksBinary(sidecarUri.fsPath)) {
    const title = `${name} (your local ↔ incoming) — binary; replace the right side, then Mark Resolved`;
    await vscode.commands.executeCommand('vscode.diff', sidecarUri, originalUri, title);
    return;
  }

  let incoming: string;
  let mine: string;
  try {
    [incoming, mine] = await Promise.all([
      fs.readFile(originalUri.fsPath, 'utf8'),
      fs.readFile(sidecarUri.fsPath, 'utf8'),
    ]);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: could not read conflict files: ${(err as Error).message}`);
    return;
  }

  // Re-running on a half-resolved file would nest markers inside markers.
  if (hasConflictMarkers(incoming)) {
    await vscode.window.showTextDocument(originalUri);
    void vscode.window.showInformationMessage(
      `${name} already has conflict markers — finish the remaining blocks, then Mark Resolved.`,
    );
    return;
  }

  const { text, conflictCount } = buildConflictText(mine, incoming, {
    ours: 'Current (your local version)',
    theirs: 'Incoming (from the branch)',
  });

  if (conflictCount === 0) {
    // The sidecar and the incoming file are identical — there is nothing to
    // decide, so the only useful action left is dropping the sidecar.
    void vscode.window.showInformationMessage(
      `${name}: your version and the incoming one are identical. Nothing to resolve.`,
    );
    await vscode.commands.executeCommand('diversion.markResolved', originalUri);
    return;
  }

  try {
    await fs.writeFile(originalUri.fsPath, text, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: could not write conflict markers: ${(err as Error).message}`);
    return;
  }

  await vscode.window.showTextDocument(originalUri);
  void vscode.window.showInformationMessage(
    `${name}: ${conflictCount} conflicting block(s). Use the Accept actions above each block, ` +
    `then run Mark Conflict Resolved.`,
  );
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
  // Deleting the sidecar throws away the only copy of the local version, so
  // refuse while unresolved markers are still in the file — that combination
  // means the user has not actually decided yet, and the markers would get
  // committed verbatim.
  const unresolved = await fs.readFile(conflict.originalPath, 'utf8')
    .then((t) => hasConflictMarkers(t))
    .catch(() => false);
  if (unresolved) {
    const proceed = await vscode.window.showWarningMessage(
      `${path.basename(conflict.originalPath)} still contains conflict markers. ` +
      `Resolve every block first — marking resolved now would commit the markers.`,
      { modal: true }, 'Open the file', 'Delete sidecar anyway',
    );
    if (proceed === 'Open the file') {
      await vscode.window.showTextDocument(vscode.Uri.file(conflict.originalPath));
      return;
    }
    if (proceed !== 'Delete sidecar anyway') return;
  }

  const ok = await vscode.window.showWarningMessage(
    `Delete sidecar ${path.basename(conflict.sidecarPath)}? Your local version lives only in that file — make sure the original now holds the content you want.`,
    { modal: true }, 'Delete sidecar',
  );
  if (ok !== 'Delete sidecar') return;
  try {
    await deleteSidecar(conflict.sidecarPath);
    // Invalidate synchronously — don't wait for the watcher's delete event,
    // which may land after this refresh and leave the resolved conflict shown.
    provider.repo.invalidateConflictCache();
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
    'BEFORE WRITING — synthesise, don\'t enumerate.',
    'Read the whole diff and identify the *one or two themes* that explain it. A theme is the user-visible behaviour or engineering goal that ties the changes together (e.g. "make folder decoration eager", "consolidate path-handling helpers", "drop the dead conflict-pruning branch"). Most commits have a single theme; describe THAT, not each file.',
    '',
    'Per-file detail is the exception, not the default. Only call out a file or change individually when it does something the theme sentence wouldn\'t lead the reader to expect. If five files all participate in the same refactor, that is ONE description, not five bullets.',
    '',
    'FORMAT',
    '1. Subject line: imperative mood, target ≤50 characters, hard limit 72. No trailing period. Conventional Commits prefix when one fits: feat, fix, refactor, perf, docs, test, build, ci, chore — with a parenthesised scope (`feat(scope): tighten X`) when the change clearly touches one area.',
    '2. Blank line.',
    '3. Body (only when it adds value beyond the subject): wrap every line at 72 columns. Explain the *why* and the trade-off when the diff makes the *what* obvious. One short paragraph is usually enough.',
    '',
    'WHEN TO USE BULLETS',
    'Use bullet points only when the diff bundles two or more *distinct* tracks of work that don\'t share a single theme. In that case, write a short lead-in paragraph explaining the overall situation, then bullets — one per genuinely independent track, not one per file. If the changes share a theme, write prose, not bullets.',
    '',
    'STYLE',
    '- Skip the body entirely when the subject already conveys everything.',
    '- Prefer specific verbs over vague ones ("rewrite" over "update", "drop" over "change", "scope to" over "limit").',
    '- Do not list filenames the diff already shows. Describe the behaviour or rationale at the level of "what changed for the user / why an engineer would care".',
    '- Never write run-on prose like "Also: ..., ..., ..." — that is the trap of trying to enumerate when you should be synthesising.',
    '',
    'HARD CAP',
    `Total message length must not exceed ${MAX_COMMIT_MESSAGE_LEN} characters (this is dv's limit). A typical good commit message is well under 1000 characters; treat the cap as a backstop, not a target.`,
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
          // Cap the running buffer at dv's accepted length so the input
          // never holds something `dv commit` would reject.
          let next = stripCodeFence(buf).trimStart();
          if (next.length > MAX_COMMIT_MESSAGE_LEN) {
            next = next.slice(0, MAX_COMMIT_MESSAGE_LEN);
          }
          provider.sourceControl.inputBox.value = next;
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
  if (message.length > MAX_COMMIT_MESSAGE_LEN) {
    void vscode.window.showErrorMessage(
      `Diversion: commit message is ${message.length} characters; ` +
      `dv accepts at most ${MAX_COMMIT_MESSAGE_LEN}. Trim it and try again.`,
    );
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
    // `doRefresh()` compares before/after commit IDs to decide whether to
    // fire `onDidChangeHistoryItemRefs`, but `waitForNewCommitId` above has
    // already updated `repo.info` to the new id before refresh ran, so the
    // comparison sees no movement and the Source Control Graph never
    // re-queries. We know for a fact the branch tip moved here — force it.
    provider.notifyHistoryRefsChanged();
    updateStatusBar();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion commit failed: ${(err as Error).message}`);
  }
}

/**
 * Prompt for a new branch name, create+switch, then commit on it. Mirrors
 * the git "Commit to New Branch" affordance for users who realise mid-commit
 * that the change belongs on its own branch.
 */
async function commitToNewBranchCommand(sourceControl?: vscode.SourceControl): Promise<void> {
  const provider = pickProvider(sourceControl);
  if (!provider) return;
  // Validate the commit message before we touch branches — switching first
  // and then bailing because the message is empty leaves the user on a new
  // branch they didn't intend to land on.
  const message = provider.sourceControl.inputBox.value.trim();
  if (!message) {
    void vscode.window.showWarningMessage('Diversion: enter a commit message first.');
    return;
  }
  if (message.length > MAX_COMMIT_MESSAGE_LEN) {
    void vscode.window.showErrorMessage(
      `Diversion: commit message is ${message.length} characters; ` +
      `dv accepts at most ${MAX_COMMIT_MESSAGE_LEN}. Trim it and try again.`,
    );
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'New branch name',
    placeHolder: 'feature/my-change',
    validateInput: (v) => v.trim() ? undefined : 'Name required',
  });
  if (!name) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv branch -c ${name.trim()}` },
      () => provider.repo.createBranch(name.trim(), true),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: create branch failed: ${(err as Error).message}`);
    return;
  }
  // Branch is created and we're on it — uncommitted changes carry over.
  // Hand off to the regular commit path so the rest of the flow (refresh,
  // graph notify, status bar) stays consistent.
  await commitCommand(sourceControl);
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
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return 'Message required';
        if (t.length > MAX_COMMIT_MESSAGE_LEN) {
          return `Too long: ${t.length} / ${MAX_COMMIT_MESSAGE_LEN} characters`;
        }
        return undefined;
      },
    });
    if (!prompt) return;
    message = prompt.trim();
  }
  if (message.length > MAX_COMMIT_MESSAGE_LEN) {
    void vscode.window.showErrorMessage(
      `Diversion: commit message is ${message.length} characters; ` +
      `dv accepts at most ${MAX_COMMIT_MESSAGE_LEN}. Trim it and try again.`,
    );
    return;
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
    // `doRefresh()` compares before/after commit IDs to decide whether to
    // fire `onDidChangeHistoryItemRefs`, but `waitForNewCommitId` above has
    // already updated `repo.info` to the new id before refresh ran, so the
    // comparison sees no movement and the Source Control Graph never
    // re-queries. We know for a fact the branch tip moved here — force it.
    provider.notifyHistoryRefsChanged();
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

async function cherryPickCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Cherry-pick which commit?');
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

async function revertCommitCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Revert which commit?');
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

async function revertToCommitCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Restore workspace to which commit?');
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

/**
 * Extract a commit ID from whatever the SCM Graph context menu hands us.
 * VS Code's `scm/historyItem/context` invocation passes the SourceControl
 * itself as the first argument (its `.id` is the provider ID, "diversion"),
 * with the SourceControlHistoryItem following. The Command Palette passes
 * nothing; programmatic callers may pass a bare ID string. Walk all args
 * and pick the one that actually looks like a history item.
 */
function commitInfoFromArgs(args: unknown[]): { id?: string; message?: string } {
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('dv.commit.')) {
      return { id: a };
    }
    if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>;
      // History items expose `parentIds` (always an array) and a `dv.commit.*`
      // id. SourceControl exposes neither — that's the discriminator.
      if (Array.isArray(o.parentIds) && typeof o.id === 'string' && o.id.startsWith('dv.commit.')) {
        return {
          id: o.id,
          message: typeof o.message === 'string' ? o.message
                 : typeof o.subject === 'string' ? o.subject
                 : undefined,
        };
      }
      if (typeof o.historyItemId === 'string' && o.historyItemId.startsWith('dv.commit.')) {
        return {
          id: o.historyItemId,
          message: typeof o.message === 'string' ? o.message : undefined,
        };
      }
    }
  }
  return {};
}

function commitIdFromArgs(args: unknown[]): string | undefined {
  return commitInfoFromArgs(args).id;
}

async function copyCommitIdCommand(...args: unknown[]): Promise<void> {
  const id = await ensureCommitId(commitIdFromArgs(args), 'Copy which commit ID?');
  if (!id) return;
  await vscode.env.clipboard.writeText(id);
  void vscode.window.showInformationMessage(`Copied ${id}`);
}

async function copyCommitMessageCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const info = commitInfoFromArgs(args);
  const id = await ensureCommitId(info.id, 'Copy message of which commit?');
  if (!id) return;
  let message = info.message;
  if (!message) {
    try {
      const details = await provider.repo.showCommit(id);
      message = details?.message;
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: load commit failed: ${(err as Error).message}`);
      return;
    }
  }
  if (!message) {
    void vscode.window.showWarningMessage(`Diversion: ${id} has no message.`);
    return;
  }
  await vscode.env.clipboard.writeText(message);
  void vscode.window.showInformationMessage(`Copied commit message (${id}).`);
}

async function createTagAtCommitCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Tag which commit?');
  if (!id) return;
  const name = await vscode.window.showInputBox({
    prompt: `Tag name for ${id}`,
    placeHolder: 'e.g. v1.2.0',
    validateInput: (s) => s.trim() ? undefined : 'Name required',
  });
  if (!name) return;
  const description = await vscode.window.showInputBox({
    prompt: 'Tag description (optional)',
    placeHolder: 'Annotate the tag, or leave blank',
  });
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: `dv tag ${name.trim()}` },
      () => provider.repo.createTag(name.trim(), id, description?.trim() || undefined),
    );
    // The graph renders tags as refs, so it has to re-query to show the new one.
    provider.notifyHistoryRefsChanged();
    void vscode.window.showInformationMessage(`Tagged ${id} as ${name.trim()}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: create tag failed: ${(err as Error).message}`);
  }
}

/**
 * Tag browser: pick a tag, then pick what to do with it. dv keys `-m` and
 * `-d` on the tag ID rather than its name, which is also the value users
 * need when scripting — hence "Copy Tag ID" as a first-class action.
 */
async function manageTagsCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  let tags: Awaited<ReturnType<typeof provider.repo.listTags>>;
  try {
    tags = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'dv tag --json' },
      () => provider.repo.listTags(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list tags failed: ${(err as Error).message}`);
    return;
  }
  if (tags.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no tags in this repo.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    tags.map((t) => ({
      label: `$(tag) ${t.name}`,
      description: [t.commitId, t.date].filter(Boolean).join(' · '),
      detail: t.description || t.id,
      tag: t,
    })),
    { placeHolder: `${tags.length} tag(s)`, matchOnDescription: true, matchOnDetail: true },
  );
  if (!pick) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(clippy) Copy Tag ID', action: 'copy' as const },
      { label: '$(globe) Open Tagged Commit in Web', action: 'show' as const },
      { label: '$(edit) Rename…', action: 'rename' as const },
      { label: '$(edit) Edit Description…', action: 'describe' as const },
      { label: '$(trash) Delete', action: 'delete' as const },
    ],
    { placeHolder: `${pick.tag.name} (${pick.tag.id})` },
  );
  if (!action) return;

  const tag = pick.tag;
  try {
    switch (action.action) {
      case 'copy':
        await vscode.env.clipboard.writeText(tag.id);
        void vscode.window.showInformationMessage(`Copied ${tag.id}.`);
        return;
      case 'show': {
        if (!tag.commitId) {
          void vscode.window.showWarningMessage(`Diversion: ${tag.name} has no commit recorded.`);
          return;
        }
        await vscode.commands.executeCommand('diversion.openCommitInWeb', tag.commitId);
        return;
      }
      case 'rename': {
        const next = await vscode.window.showInputBox({
          prompt: `Rename ${tag.name}`,
          value: tag.name,
          validateInput: (s) => s.trim() ? undefined : 'Name required',
        });
        if (!next || next.trim() === tag.name) return;
        await provider.repo.modifyTag(tag.id, { name: next.trim() });
        void vscode.window.showInformationMessage(`Renamed ${tag.name} to ${next.trim()}.`);
        break;
      }
      case 'describe': {
        const next = await vscode.window.showInputBox({
          prompt: `Description for ${tag.name}`,
          value: tag.description ?? '',
        });
        if (next === undefined) return;
        await provider.repo.modifyTag(tag.id, { description: next.trim() });
        void vscode.window.showInformationMessage(`Updated description for ${tag.name}.`);
        break;
      }
      case 'delete': {
        const ok = await vscode.window.showWarningMessage(
          `Delete tag ${tag.name} (${tag.id})?`,
          { modal: true }, 'Delete',
        );
        if (ok !== 'Delete') return;
        await provider.repo.deleteTag(tag.id);
        void vscode.window.showInformationMessage(`Deleted tag ${tag.name}.`);
        break;
      }
    }
    provider.notifyHistoryRefsChanged();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: tag operation failed: ${(err as Error).message}`);
  }
}

async function compareWithCommitCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const baseId = await ensureCommitId(commitIdFromArgs(args), 'Compare which commit?');
  if (!baseId) return;
  let commits;
  try {
    commits = await provider.repo.logFull(200);
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: load history failed: ${(err as Error).message}`);
    return;
  }
  const items = commits
    .filter((c) => c.id !== baseId)
    .map((c) => ({
      label: c.message.split('\n', 1)[0] ?? c.id,
      description: c.id,
      detail: `${c.authorName} · ${c.date}`,
      commitId: c.id,
    }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Compare ${baseId} with…`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;
  try {
    const diff = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `dv diff ${baseId}…${pick.commitId}` },
      () => provider.repo.diffBetween(baseId, pick.commitId),
    );
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: diff });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: diff failed: ${(err as Error).message}`);
  }
}

async function openCommitInWebCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Open which commit in the web UI?');
  if (!id) return;
  const { repoId, workspaceId } = provider.repo.info;
  if (!repoId || !workspaceId) {
    void vscode.window.showErrorMessage('Diversion: repo/workspace ID unavailable; cannot build web URL.');
    return;
  }
  const url = `https://app.diversion.dev/repo/${repoId}/workspace/${workspaceId}/view/${id}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function checkoutBranchAtCommitCommand(...args: unknown[]): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  const id = await ensureCommitId(commitIdFromArgs(args), 'Checkout a branch at which commit?');
  if (!id) return;

  let branches: Awaited<ReturnType<typeof provider.repo.listBranches>>;
  try {
    branches = await provider.repo.listBranches();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: list branches failed: ${(err as Error).message}`);
    return;
  }
  const atCommit = branches.filter((b) => b.commitId === id);
  if (atCommit.length === 0) {
    void vscode.window.showInformationMessage(
      `Diversion: no branches at ${id}. dv has no detached-HEAD mode — use "Restore Workspace To Commit" instead.`,
    );
    return;
  }
  const current = provider.repo.info.branchName;
  const items = atCommit.map((b) => ({
    label: b.name === current ? `$(check) ${b.name}` : b.name,
    description: b.commitId,
    detail: b.id,
    branchName: b.name,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Branches at ${id}`,
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
    void vscode.window.showErrorMessage(`Diversion: checkout failed: ${(err as Error).message}`);
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
    // `dv merge` exits 0 whether it merged cleanly or parked the merge on
    // conflicts, so "success" alone doesn't mean the branch actually moved.
    const parked = await openMergesFor(provider);
    if (parked.length > 0) {
      await promptToResolveMerges(provider, parked, `Merge of ${pick.branchName} stopped on conflicts.`);
    } else {
      void vscode.window.showInformationMessage(`Merged ${pick.branchName} into ${current}.`);
    }
  } catch (err) {
    const parked = await openMergesFor(provider);
    if (parked.length > 0) {
      await promptToResolveMerges(provider, parked, `Merge of ${pick.branchName} stopped on conflicts.`);
      return;
    }
    void vscode.window.showErrorMessage(`Diversion: merge failed: ${(err as Error).message}`);
  }
}

/**
 * Open (conflicting) merges for a repo, best-effort. Never throws — this runs
 * on the tail of another operation whose outcome we've already reported, so a
 * CoreAPI blip must not turn a successful merge into an error toast.
 */
async function openMergesFor(provider: DiversionScmProvider): Promise<OpenMerge[]> {
  try {
    return await provider.repo.listOpenMerges();
  } catch (err) {
    logger?.warn(`[merge] could not list open merges: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Conflicting merges are resolved block-by-block in the Diversion app — there
 * is no filesystem representation for us to hand to VS Code's merge editor
 * (unlike `.dv-conflict` sidecars, which are a different thing entirely). The
 * useful thing we can do is say so plainly and open the app on the repo.
 */
async function promptToResolveMerges(
  provider: DiversionScmProvider,
  merges: readonly OpenMerge[],
  headline: string,
): Promise<void> {
  const detail = merges.length === 1
    ? `${merges[0]!.otherRef} → ${merges[0]!.baseRef}`
    : `${merges.length} unresolved merges`;
  const choice = await vscode.window.showWarningMessage(
    `Diversion: ${headline} Resolve the conflicting blocks in the Diversion app (${detail}).`,
    'Open in Diversion',
  );
  if (choice === 'Open in Diversion') {
    try {
      await provider.repo.openInWeb();
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: could not open the app: ${(err as Error).message}`);
    }
  }
}

async function showOpenMergesCommand(): Promise<void> {
  const provider = activeProvider();
  if (!provider) return;
  let merges: OpenMerge[];
  try {
    merges = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Diversion: checking for unresolved merges' },
      () => provider.repo.listOpenMerges(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: could not list merges: ${(err as Error).message}`);
    return;
  }
  if (merges.length === 0) {
    void vscode.window.showInformationMessage('Diversion: no unresolved merges.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    merges.map((m) => ({
      label: `$(git-merge) ${m.otherRef} → ${m.baseRef}`,
      description: m.startedBy ? `started by ${m.startedBy}` : undefined,
      detail: m.id,
    })),
    { placeHolder: `${merges.length} unresolved merge(s) — pick one to resolve in the Diversion app` },
  );
  if (!pick) return;
  try {
    await provider.repo.openInWeb();
  } catch (err) {
    void vscode.window.showErrorMessage(`Diversion: could not open the app: ${(err as Error).message}`);
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
