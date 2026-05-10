import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Repo } from '../diversion/repo.js';
import type { Logger } from '../util/log.js';
import { isInsideOrEqual } from '../util/path.js';

/**
 * Registers Diversion's read-only operations as `vscode.LanguageModelTool`s
 * so Copilot Chat (and any other consumer of the VS Code Language Model API)
 * can inspect SCM state without having to shell out to `dv` directly.
 *
 * Tools register with the same names declared under
 * `contributes.languageModelTools` in package.json — keep them in sync.
 *
 * Note: `vscode.lm.registerTool` requires VS Code 1.95+. We feature-detect
 * so older hosts fall back to the SCM panel UI silently.
 */

type RepoSource = () => Iterable<Repo>;

interface RepoArg { repo?: string }
interface DiffArg extends RepoArg { paths?: string[] }
interface LogArg extends RepoArg { limit?: number }

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
  // Match by repo name first (cheap), then by path containment.
  for (const r of repos) if (r.info.repoName === hint) return r;
  const norm = path.resolve(hint);
  for (const r of repos) if (isInsideOrEqual(r.root, norm)) return r;
  const names = repos.map((r) => r.info.repoName).join(', ');
  throw new Error(`No repo matched "${hint}". Available: ${names}.`);
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

class StatusTool implements vscode.LanguageModelTool<RepoArg> {
  constructor(private readonly getRepos: RepoSource) {}
  async invoke(opts: vscode.LanguageModelToolInvocationOptions<RepoArg>): Promise<vscode.LanguageModelToolResult> {
    const repo = pickRepo(this.getRepos, opts.input.repo);
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
    return textResult(lines.join('\n'));
  }
}

class DiffTool implements vscode.LanguageModelTool<DiffArg> {
  constructor(private readonly getRepos: RepoSource) {}
  async invoke(opts: vscode.LanguageModelToolInvocationOptions<DiffArg>): Promise<vscode.LanguageModelToolResult> {
    const repo = pickRepo(this.getRepos, opts.input.repo);
    const diff = await repo.unifiedDiff(opts.input.paths);
    return textResult(diff.trim() || '(no working-tree differences)');
  }
}

class LogTool implements vscode.LanguageModelTool<LogArg> {
  constructor(private readonly getRepos: RepoSource) {}
  async invoke(opts: vscode.LanguageModelToolInvocationOptions<LogArg>): Promise<vscode.LanguageModelToolResult> {
    const repo = pickRepo(this.getRepos, opts.input.repo);
    const limit = Math.max(1, Math.min(200, opts.input.limit ?? 20));
    const commits = await repo.logFull(limit);
    if (commits.length === 0) return textResult('(no commits)');
    const blocks = commits.map((c) => {
      const refs = c.refs.length > 0 ? ` (${c.refs.join(', ')})` : '';
      const indented = c.message.replace(/\n/g, '\n  ');
      return `${c.id}${refs}\n  ${c.authorName} <${c.authorEmail}>  ${c.date}\n  ${indented}`;
    });
    return textResult(blocks.join('\n\n'));
  }
}

class BranchesTool implements vscode.LanguageModelTool<RepoArg> {
  constructor(private readonly getRepos: RepoSource) {}
  async invoke(opts: vscode.LanguageModelToolInvocationOptions<RepoArg>): Promise<vscode.LanguageModelToolResult> {
    const repo = pickRepo(this.getRepos, opts.input.repo);
    const branches = await repo.listBranches();
    if (branches.length === 0) return textResult('(no branches)');
    const current = repo.info.branchName;
    const lines = branches.map((b) =>
      `${b.name === current ? '* ' : '  '}${b.name}  ${b.commitId}`,
    );
    return textResult(lines.join('\n'));
  }
}

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  getRepos: RepoSource,
  log: Logger,
): void {
  // Feature-detect: registerTool was finalized in VS Code 1.95. Older hosts
  // simply skip registration — the SCM panel still works.
  const lm = (vscode as { lm?: { registerTool?: typeof vscode.lm.registerTool } }).lm;
  if (!lm?.registerTool) {
    log.info('Language Model Tools API not available on this VS Code version; skipping registration.');
    return;
  }
  try {
    context.subscriptions.push(
      lm.registerTool('diversion_status', new StatusTool(getRepos)),
      lm.registerTool('diversion_diff', new DiffTool(getRepos)),
      lm.registerTool('diversion_log', new LogTool(getRepos)),
      lm.registerTool('diversion_branches', new BranchesTool(getRepos)),
    );
    log.info('Registered 4 language model tools: diversion_{status,diff,log,branches}');
  } catch (err) {
    log.warn(`Failed to register language model tools: ${(err as Error).message}`);
  }
}
