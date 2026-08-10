import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';
import { isInsideOrEqual } from '../util/path.js';

/**
 * Registers Diversion operations as `vscode.LanguageModelTool`s so Copilot
 * Chat (and any other consumer of the VS Code Language Model API) can
 * inspect and operate on SCM state without shelling out to `dv` directly.
 *
 * Tool names mirror the entries under `contributes.languageModelTools` in
 * package.json — keep them in sync. The same set is exposed by the
 * standalone MCP server under `src/mcp/`, so a tool defined here usually
 * has a sibling there.
 *
 * `vscode.lm.registerTool` requires VS Code 1.95+. We feature-detect so
 * older hosts fall back to the SCM panel UI silently.
 */

type RepoSource = () => Iterable<Repo>;

interface RepoArg { repo?: string }
interface DiffArg extends RepoArg { paths?: string[] }
interface DiffRefsArg extends RepoArg { base: string; compare: string }
interface CommitIdArg extends RepoArg { commit: string }
interface PathArg extends RepoArg { path: string }

interface CommitArg extends RepoArg { message: string; paths?: string[] }
interface CreateBranchArg extends RepoArg { name: string; switchTo?: boolean }
interface CheckoutArg extends RepoArg {
  ref: string;
  takeChanges?: boolean;
  shelveChanges?: boolean;
  discardChanges?: boolean;
  applyShelf?: boolean;
}
interface MergeArg extends RepoArg {
  ref: string;
  /** Merge's enum differs from revert/update: `keep-destination`, not `keep-current`. */
  conflictResolution?: 'manual' | 'keep-destination' | 'accept-incoming';
}
interface RevertArg extends CommitIdArg {
  conflictResolution?: 'manual' | 'keep-current' | 'accept-incoming';
}
interface RestoreArg extends RepoArg { ref: string; path: string }
interface DiscardAllArg extends RepoArg { includeNew?: boolean }
interface TagArg extends RepoArg { name: string; commit?: string; description?: string }
interface ShelfCreateArg extends RepoArg {
  name: string;
  paths?: string[];
  keepWorkingChanges?: boolean;
}
interface ShelfApplyArg extends RepoArg { shelf: string; keepShelfAfter?: boolean }
interface ShelfArg extends RepoArg { shelf: string }
interface ShelfRenameArg extends ShelfArg { newName: string }
interface LogFilteredArg extends RepoArg { limit?: number; since?: string; until?: string }
interface FileHistoryArg extends LogFilteredArg { path: string }
interface OverlapArg extends RepoArg { lookback?: number; since?: string }
interface BranchArg extends RepoArg { branch: string }
interface BranchRenameArg extends BranchArg { newName: string }

function pickRepo(getRepos: RepoSource, hint?: string): Repo {
  const repos = [...getRepos()];
  if (repos.length === 0) {
    throw new Error('No Diversion repositories are registered in this workspace.');
  }
  if (!hint) {
    if (repos.length === 1) return repos[0]!;
    const names = repos.map((r) => r.info.repoName).join(', ');
    throw new Error(
      `Multiple Diversion repos open (${names}). Pass the "repo" argument — repo name or an absolute path inside the repo.`,
    );
  }
  for (const r of repos) if (r.info.repoName === hint) return r;
  const norm = path.resolve(hint);
  for (const r of repos) if (isInsideOrEqual(r.root, norm)) return r;
  const names = repos.map((r) => r.info.repoName).join(', ');
  throw new Error(`No repo matched "${hint}". Available: ${names}.`);
}

/**
 * Cap on characters returned from any single tool. An unbounded diff / status
 * / annotate of a large repo would otherwise blow the model's context window.
 * ~100k chars ≈ 25k tokens.
 */
const MAX_TOOL_TEXT = 100_000;

function textResult(text: string): vscode.LanguageModelToolResult {
  const capped = text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n\n…[truncated: ${text.length - MAX_TOOL_TEXT} of ${text.length} characters omitted — narrow the request (fewer paths, a smaller ref range, or a limit)]`
    : text;
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(capped)]);
}

function nonEmpty(name: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new Error(`Tool argument "${name}" is required.`);
  return trimmed;
}

/**
 * Generic tool adapter — handles the common "pick repo, run body, wrap
 * result text" boilerplate. The body can throw; the LM API renders the
 * Error message as the tool failure.
 */
class FnTool<TArgs extends RepoArg> implements vscode.LanguageModelTool<TArgs> {
  constructor(
    private readonly getRepos: RepoSource,
    private readonly body: (repo: Repo, args: TArgs) => Promise<string>,
  ) {}
  async invoke(
    opts: vscode.LanguageModelToolInvocationOptions<TArgs>,
  ): Promise<vscode.LanguageModelToolResult> {
    const repo = pickRepo(this.getRepos, opts.input.repo);
    const out = await this.body(repo, opts.input);
    return textResult(out);
  }
}

// ─── tool bodies ──────────────────────────────────────────────────────

async function statusBody(repo: Repo): Promise<string> {
  const state = await repo.getState();
  const lines: string[] = [];
  lines.push(`Repository: ${repo.info.repoName}`);
  lines.push(`Branch: ${repo.info.branchName || '<unknown>'}`);
  lines.push(`Commit: ${repo.info.commitId || '<none>'}`);
  if (repo.info.paused) lines.push('Sync: PAUSED');
  if (repo.info.readOnly) lines.push('ReadOnly: true');
  lines.push(`Workspace path: ${repo.root}`);
  lines.push('');
  if (state.changes.length === 0) {
    lines.push('No working changes.');
  } else {
    lines.push(`Changes (${state.changes.length}):`);
    for (const c of state.changes) lines.push(`  ${c.kind.padEnd(8)} ${c.path}`);
  }
  if (state.conflicts.length > 0) {
    lines.push('');
    lines.push(`Conflicts (${state.conflicts.length}):`);
    for (const c of state.conflicts) lines.push(`  ${c.originalPath}  ↔  ${c.sidecarPath}`);
  }
  return lines.join('\n');
}

async function diffBody(repo: Repo, args: DiffArg): Promise<string> {
  const diff = await repo.unifiedDiff(args.paths);
  return diff.trim() || '(no working-tree differences)';
}

async function diffRefsBody(repo: Repo, args: DiffRefsArg): Promise<string> {
  const diff = await repo.diffBetween(nonEmpty('base', args.base), nonEmpty('compare', args.compare));
  return diff.trim() || '(no differences between refs)';
}

function formatCommits(commits: Awaited<ReturnType<Repo['logFull']>>): string {
  if (commits.length === 0) return '(no commits)';
  return commits.map((c) => {
    const refs = c.refs.length > 0 ? ` (${c.refs.join(', ')})` : '';
    const indented = c.message.replace(/\n/g, '\n  ');
    return `${c.id}${refs}\n  ${c.authorName} <${c.authorEmail}>  ${c.date}\n  ${indented}`;
  }).join('\n\n');
}

async function logBody(repo: Repo, args: LogFilteredArg): Promise<string> {
  const opts: { limit?: number; since?: string; until?: string } = {
    limit: Math.max(1, Math.min(1000, args.limit ?? 20)),
  };
  if (args.since) opts.since = args.since;
  if (args.until) opts.until = args.until;
  return formatCommits(await repo.logFiltered(opts));
}

async function fileHistoryBody(repo: Repo, args: FileHistoryArg): Promise<string> {
  const opts: { path: string; limit?: number; since?: string; until?: string } = {
    path: nonEmpty('path', args.path),
    limit: Math.max(1, Math.min(1000, args.limit ?? 20)),
  };
  if (args.since) opts.since = args.since;
  if (args.until) opts.until = args.until;
  const commits = await repo.logFiltered(opts);
  if (commits.length === 0) return `(no commits touch ${args.path})`;
  return formatCommits(commits);
}

async function overlappingCommitsBody(repo: Repo, args: OverlapArg): Promise<string> {
  const opts: { lookback?: number; since?: string } = {
    lookback: Math.max(1, Math.min(500, args.lookback ?? 50)),
  };
  if (args.since) opts.since = args.since;
  const matches = await repo.overlappingCommits(opts);
  if (matches.length === 0) {
    return '(no recent commits touch the paths you have working changes in)';
  }
  return matches.map(({ commit, touched }) => {
    const refs = commit.refs.length > 0 ? ` (${commit.refs.join(', ')})` : '';
    const subject = commit.message.split('\n', 1)[0] ?? '';
    const paths = touched.map((p) => `    - ${p}`).join('\n');
    return `${commit.id}${refs}  ${commit.authorName}  ${commit.date}\n  ${subject}\n  Overlapping paths (${touched.length}):\n${paths}`;
  }).join('\n\n');
}

async function listTagsBody(repo: Repo): Promise<string> {
  const tags = await repo.listTags();
  if (tags.length === 0) return '(no tags)';
  return tags.map((t) => {
    const commit = t.commitId ? ` → ${t.commitId}` : '';
    const desc = t.description ? `  — ${t.description}` : '';
    return `${t.id}  ${t.name}${commit}${desc}`;
  }).join('\n');
}

async function listCloudReposBody(repo: Repo): Promise<string> {
  const repos = await repo.listCloudRepos();
  if (repos.length === 0) return '(no repos accessible to this account)';
  const cloned = repos.filter((r) => r.cloned);
  const other = repos.filter((r) => !r.cloned);
  const lines: string[] = [];
  if (cloned.length > 0) {
    lines.push(`Cloned locally (${cloned.length}):`);
    for (const r of cloned) lines.push(`  ${r.name}  ${r.id}  ${r.localPath ?? ''}`);
  }
  if (other.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Remote only (${other.length}):`);
    for (const r of other) lines.push(`  ${r.name}  ${r.id}`);
  }
  return lines.join('\n');
}

async function showShelfBody(repo: Repo, args: ShelfArg): Promise<string> {
  const out = await repo.showShelf(nonEmpty('shelf', args.shelf));
  return out.trim() || '(shelf is empty)';
}

async function deleteBranchBody(repo: Repo, args: BranchArg): Promise<string> {
  const name = nonEmpty('branch', args.branch);
  await repo.deleteBranch(name);
  return `Branch "${name}" deleted.`;
}

async function renameBranchBody(repo: Repo, args: BranchRenameArg): Promise<string> {
  await repo.renameBranch(nonEmpty('branch', args.branch), nonEmpty('newName', args.newName));
  return `Branch renamed to "${args.newName}".`;
}

async function showBody(repo: Repo, args: CommitIdArg): Promise<string> {
  const commitId = nonEmpty('commit', args.commit);
  const [details, changes] = await Promise.all([
    repo.showCommit(commitId),
    repo.fileChangesForCommit(commitId).catch(() => []),
  ]);
  if (!details) return `No commit found for "${commitId}".`;
  const lines: string[] = [];
  const refs = details.refs.length > 0 ? ` (${details.refs.join(', ')})` : '';
  lines.push(`${details.id}${refs}`);
  lines.push(`Author: ${details.authorName} <${details.authorEmail}>`);
  lines.push(`Date:   ${details.date}`);
  if (details.merge) lines.push(`Merge:  ${details.merge.refName} ${details.merge.commitId}`);
  lines.push('');
  lines.push(details.message);
  if (changes.length > 0) {
    lines.push('');
    lines.push(`Files (${changes.length}):`);
    for (const c of changes) lines.push(`  ${c.kind.padEnd(8)} ${c.path}`);
  }
  return lines.join('\n');
}

async function branchesBody(repo: Repo): Promise<string> {
  const branches = await repo.listBranches();
  if (branches.length === 0) return '(no branches)';
  const current = repo.info.branchName;
  return branches.map((b) =>
    `${b.name === current ? '* ' : '  '}${b.name}  ${b.commitId}`,
  ).join('\n');
}

async function shelvesBody(repo: Repo): Promise<string> {
  const shelves = await repo.listShelves();
  if (shelves.length === 0) return '(no shelves)';
  return shelves.map((s) => {
    const id = s.id ? `${s.id}  ` : '';
    const desc = s.description ? `  — ${s.description}` : '';
    return `${id}${s.name}${desc}`;
  }).join('\n');
}

async function locksBody(repo: Repo): Promise<string> {
  const locks = await repo.listLocks();
  if (locks.length === 0) return '(no active locks)';
  return locks.map((l) => {
    const holder = l.holder ? `  held by ${l.holder}` : '';
    return `${l.path}${holder}`;
  }).join('\n');
}

async function annotateBody(repo: Repo, args: PathArg): Promise<string> {
  const lines = await repo.annotate(nonEmpty('path', args.path));
  if (lines.length === 0) return '(no annotation lines)';
  return lines.map((a) => {
    const id = a.uncommitted ? 'uncommitted' : (a.commitId ?? '?');
    const author = a.author ?? '?';
    const date = a.date ?? '?';
    return `${id.padEnd(20)} ${author.padEnd(24)} ${date}  ${a.lineNumber.toString().padStart(5)}) ${a.content}`;
  }).join('\n');
}

async function commitBody(repo: Repo, args: CommitArg): Promise<string> {
  await repo.commit(nonEmpty('message', args.message), args.paths);
  await repo.notifySyncRequired().catch(() => undefined);
  return `Commit created on ${repo.info.branchName || '<branch>'}.`;
}

async function createBranchBody(repo: Repo, args: CreateBranchArg): Promise<string> {
  const name = nonEmpty('name', args.name);
  await repo.createBranch(name, args.switchTo ?? true);
  return `Branch "${name}" created${args.switchTo === false ? '' : ' and checked out'}.`;
}

async function checkoutBody(repo: Repo, args: CheckoutArg): Promise<string> {
  const ref = nonEmpty('ref', args.ref);
  const opts: {
    takeChanges?: boolean;
    shelveChanges?: boolean;
    discardChanges?: boolean;
    applyShelf?: boolean;
  } = {};
  if (args.takeChanges) opts.takeChanges = true;
  if (args.shelveChanges) opts.shelveChanges = true;
  if (args.discardChanges) opts.discardChanges = true;
  if (args.applyShelf) opts.applyShelf = true;
  await repo.checkout(ref, opts);
  return `Checked out "${ref}".`;
}

async function mergeBody(repo: Repo, args: MergeArg): Promise<string> {
  const ref = nonEmpty('ref', args.ref);
  await repo.merge(ref, args.conflictResolution);
  // dv exits 0 whether the merge landed or was parked on conflicts, so the
  // only honest way to report the outcome is to ask which happened.
  const parked = await repo.listOpenMerges().catch(() => []);
  if (parked.length > 0) {
    return `Merge of "${ref}" stopped on conflicts; ${parked.length} unresolved merge(s). ` +
      `Conflicting blocks are resolved in the Diversion app, not on disk.`;
  }
  return `Merged "${ref}" into ${repo.info.branchName || '<branch>'}.`;
}

async function openMergesBody(repo: Repo): Promise<string> {
  const merges = await repo.listOpenMerges();
  if (merges.length === 0) return 'No unresolved merges.';
  return merges
    .map((m) => `${m.id}\t${m.otherRef} → ${m.baseRef}${m.startedBy ? `\t(${m.startedBy})` : ''}`)
    .join('\n');
}

async function cherryPickBody(repo: Repo, args: CommitIdArg): Promise<string> {
  await repo.cherryPick(nonEmpty('commit', args.commit));
  return `Cherry-picked ${args.commit}.`;
}

async function revertCommitBody(repo: Repo, args: RevertArg): Promise<string> {
  await repo.revertCommit(nonEmpty('commit', args.commit), args.conflictResolution);
  return `Reverted ${args.commit}.`;
}

async function revertToCommitBody(repo: Repo, args: CommitIdArg): Promise<string> {
  await repo.revertToCommit(nonEmpty('commit', args.commit));
  return `Workspace restored to ${args.commit}.`;
}

async function restorePathBody(repo: Repo, args: RestoreArg): Promise<string> {
  await repo.restorePath(nonEmpty('ref', args.ref), nonEmpty('path', args.path));
  return `Restored ${args.path} from ${args.ref}.`;
}

async function discardPathBody(repo: Repo, args: PathArg): Promise<string> {
  await repo.discardPath(nonEmpty('path', args.path));
  return `Discarded changes to ${args.path}.`;
}

async function discardAllBody(repo: Repo, args: DiscardAllArg): Promise<string> {
  await repo.discardAll(args.includeNew ?? false);
  return `Discarded all working-tree changes${args.includeNew ? ' (including new files)' : ''}.`;
}

async function createTagBody(repo: Repo, args: TagArg): Promise<string> {
  const name = nonEmpty('name', args.name);
  await repo.createTag(name, args.commit, args.description);
  return `Tag "${name}" created${args.commit ? ` at ${args.commit}` : ''}.`;
}

async function createShelfBody(repo: Repo, args: ShelfCreateArg): Promise<string> {
  const name = nonEmpty('name', args.name);
  await repo.createShelf(name, args.paths, args.keepWorkingChanges ?? false);
  return `Shelf "${name}" created.`;
}

async function applyShelfBody(repo: Repo, args: ShelfApplyArg): Promise<string> {
  const shelf = nonEmpty('shelf', args.shelf);
  await repo.applyShelf(shelf, args.keepShelfAfter ?? false);
  return `Applied shelf "${shelf}".`;
}

async function deleteShelfBody(repo: Repo, args: ShelfArg): Promise<string> {
  const shelf = nonEmpty('shelf', args.shelf);
  await repo.deleteShelf(shelf);
  return `Shelf "${shelf}" deleted.`;
}

async function renameShelfBody(repo: Repo, args: ShelfRenameArg): Promise<string> {
  await repo.renameShelf(nonEmpty('shelf', args.shelf), nonEmpty('newName', args.newName));
  return `Shelf renamed to "${args.newName}".`;
}

async function lockPathBody(repo: Repo, args: PathArg): Promise<string> {
  await repo.lockPath(nonEmpty('path', args.path));
  return `Locked ${args.path}.`;
}

async function unlockPathBody(repo: Repo, args: PathArg): Promise<string> {
  await repo.unlockPath(nonEmpty('path', args.path));
  return `Unlocked ${args.path}.`;
}

async function pauseSyncBody(repo: Repo): Promise<string> {
  await repo.pauseSync();
  return `Sync paused for ${repo.info.repoName}.`;
}

async function resumeSyncBody(repo: Repo): Promise<string> {
  await repo.resumeSync();
  return `Sync resumed for ${repo.info.repoName}.`;
}

async function updateWorkspaceBody(repo: Repo): Promise<string> {
  await repo.updateWorkspace();
  await repo.refreshIdentity().catch(() => undefined);
  return `Workspace updated. Now on commit ${repo.info.commitId || '<unknown>'}.`;
}

async function verifyBody(repo: Repo): Promise<string> {
  const out = await repo.verify();
  return out.trim() || '(verify produced no output)';
}

// ─── registration ────────────────────────────────────────────────────

interface ToolEntry {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: () => vscode.LanguageModelTool<any>;
}

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  getRepos: RepoSource,
  log: Logger,
): void {
  const lm = (vscode as { lm?: { registerTool?: typeof vscode.lm.registerTool } }).lm;
  if (!lm?.registerTool) {
    log.info('Language Model Tools API not available on this VS Code version; skipping registration.');
    return;
  }

  const tools: ToolEntry[] = [
    { name: 'diversion_status',           factory: () => new FnTool(getRepos, statusBody) },
    { name: 'diversion_diff',             factory: () => new FnTool(getRepos, diffBody) },
    { name: 'diversion_diff_refs',        factory: () => new FnTool(getRepos, diffRefsBody) },
    { name: 'diversion_log',              factory: () => new FnTool(getRepos, logBody) },
    { name: 'diversion_file_history',     factory: () => new FnTool(getRepos, fileHistoryBody) },
    { name: 'diversion_overlapping_commits', factory: () => new FnTool(getRepos, overlappingCommitsBody) },
    { name: 'diversion_show',             factory: () => new FnTool(getRepos, showBody) },
    { name: 'diversion_branches',         factory: () => new FnTool(getRepos, branchesBody) },
    { name: 'diversion_list_tags',        factory: () => new FnTool(getRepos, listTagsBody) },
    { name: 'diversion_list_cloud_repos', factory: () => new FnTool(getRepos, listCloudReposBody) },
    { name: 'diversion_shelves',          factory: () => new FnTool(getRepos, shelvesBody) },
    { name: 'diversion_show_shelf',       factory: () => new FnTool(getRepos, showShelfBody) },
    { name: 'diversion_locks',            factory: () => new FnTool(getRepos, locksBody) },
    { name: 'diversion_annotate',         factory: () => new FnTool(getRepos, annotateBody) },
    { name: 'diversion_commit',           factory: () => new FnTool(getRepos, commitBody) },
    { name: 'diversion_create_branch',    factory: () => new FnTool(getRepos, createBranchBody) },
    { name: 'diversion_delete_branch',    factory: () => new FnTool(getRepos, deleteBranchBody) },
    { name: 'diversion_rename_branch',    factory: () => new FnTool(getRepos, renameBranchBody) },
    { name: 'diversion_checkout',         factory: () => new FnTool(getRepos, checkoutBody) },
    { name: 'diversion_merge',            factory: () => new FnTool(getRepos, mergeBody) },
    { name: 'diversion_open_merges',      factory: () => new FnTool(getRepos, openMergesBody) },
    { name: 'diversion_cherry_pick',      factory: () => new FnTool(getRepos, cherryPickBody) },
    { name: 'diversion_revert_commit',    factory: () => new FnTool(getRepos, revertCommitBody) },
    { name: 'diversion_revert_to_commit', factory: () => new FnTool(getRepos, revertToCommitBody) },
    { name: 'diversion_restore_path',     factory: () => new FnTool(getRepos, restorePathBody) },
    { name: 'diversion_discard_path',     factory: () => new FnTool(getRepos, discardPathBody) },
    { name: 'diversion_discard_all',      factory: () => new FnTool(getRepos, discardAllBody) },
    { name: 'diversion_create_tag',       factory: () => new FnTool(getRepos, createTagBody) },
    { name: 'diversion_create_shelf',     factory: () => new FnTool(getRepos, createShelfBody) },
    { name: 'diversion_apply_shelf',      factory: () => new FnTool(getRepos, applyShelfBody) },
    { name: 'diversion_delete_shelf',     factory: () => new FnTool(getRepos, deleteShelfBody) },
    { name: 'diversion_rename_shelf',     factory: () => new FnTool(getRepos, renameShelfBody) },
    { name: 'diversion_lock_path',        factory: () => new FnTool(getRepos, lockPathBody) },
    { name: 'diversion_unlock_path',      factory: () => new FnTool(getRepos, unlockPathBody) },
    { name: 'diversion_pause_sync',       factory: () => new FnTool(getRepos, pauseSyncBody) },
    { name: 'diversion_resume_sync',      factory: () => new FnTool(getRepos, resumeSyncBody) },
    { name: 'diversion_update_workspace', factory: () => new FnTool(getRepos, updateWorkspaceBody) },
    { name: 'diversion_verify',           factory: () => new FnTool(getRepos, verifyBody) },
  ];

  let registered = 0;
  for (const t of tools) {
    try {
      context.subscriptions.push(lm.registerTool(t.name, t.factory()));
      registered++;
    } catch (err) {
      log.warn(`Failed to register ${t.name}: ${(err as Error).message}`);
    }
  }
  log.info(`Registered ${registered}/${tools.length} language model tools.`);
}
