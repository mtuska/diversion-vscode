import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Repo } from '../diversion/repo.js';
import type { RepoRegistry } from './repoRegistry.js';

type TextResult = CallToolResult;

/**
 * Upper bound on characters returned from any single tool. An unbounded diff /
 * status / annotate of a large repo would otherwise blow the model's context
 * window (and buffer megabytes into the client). ~100k chars ≈ 25k tokens.
 */
const MAX_TOOL_TEXT = 100_000;

function truncateForModel(s: string): string {
  if (s.length <= MAX_TOOL_TEXT) return s;
  return `${s.slice(0, MAX_TOOL_TEXT)}\n\n…[truncated: ${s.length - MAX_TOOL_TEXT} of ${s.length} characters omitted — narrow the request (fewer paths, a smaller ref range, or a limit)]`;
}

const text = (s: string): TextResult => ({
  content: [{ type: 'text', text: truncateForModel(s) }],
});

const errText = (s: string): TextResult => ({
  isError: true,
  content: [{ type: 'text', text: s }],
});

const repoArg = {
  repo: z.string().optional().describe(
    'Optional. Repository name (e.g. "MyProject") or an absolute filesystem path inside the repo. ' +
    'Required if multiple Diversion repos are registered; omit when there is only one.',
  ),
};

/**
 * Wrap a tool body so it always returns a clean `CallToolResult` and never
 * throws across the MCP wire. The SDK will surface uncaught throws as a
 * client-side fault; we prefer a clean `{ isError: true, content: [...] }`
 * that the model can read and recover from.
 */
function safe<TArgs>(
  registry: RepoRegistry,
  body: (args: TArgs, repo: Repo) => Promise<TextResult>,
  needsRepo = true,
): (args: TArgs) => Promise<TextResult> {
  return async (args: TArgs) => {
    try {
      if (!needsRepo) {
        return await body(args, undefined as unknown as Repo);
      }
      const hint = (args as { repo?: string } | undefined)?.repo;
      const repo = await registry.pick(hint);
      return await body(args, repo);
    } catch (err) {
      return errText((err as Error).message || String(err));
    }
  };
}

function nonEmpty(name: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new Error(`Tool argument "${name}" is required.`);
  return trimmed;
}

export interface RegisterToolsOptions {
  /**
   * When true, only the read-only tools are registered — every mutating tool
   * (commit, checkout, discard, delete-branch, merge, revert, shelf mutations,
   * lock, sync pause/resume, …) is omitted entirely. Gated by the
   * DIVERSION_MCP_READONLY env var so an operator can hand an agent a
   * look-but-don't-touch surface.
   */
  readOnly?: boolean;
}

export function registerAllTools(
  server: McpServer,
  registry: RepoRegistry,
  opts: RegisterToolsOptions = {},
): void {
  // ─── read tools ──────────────────────────────────────────────────────

  server.registerTool(
    'dv_list_repos',
    {
      title: 'Diversion: list registered repos',
      description:
        'List every Diversion repository the MCP server is aware of, with its branch, ' +
        'tip commit, sync state, and workspace path. Use this when the user asks "what ' +
        'repos do I have open" or before any tool that takes a `repo` hint.',
      inputSchema: {},
    },
    safe(registry, async () => {
      const repos = registry.list();
      if (repos.length === 0) return text('(no Diversion repos registered)');
      const lines: string[] = [];
      for (const r of repos) {
        await r.refreshIdentity().catch(() => undefined);
        const flags: string[] = [];
        if (r.info.paused) flags.push('paused');
        if (r.info.readOnly) flags.push('readonly');
        const f = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        lines.push(`${r.info.repoName || '<unnamed>'}\t${r.info.branchName || '<unknown>'}\t${r.info.commitId || '<none>'}\t${r.root}${f}`);
      }
      return text(lines.join('\n'));
    }, false),
  );

  server.registerTool(
    'dv_status',
    {
      title: 'Diversion: working-tree status',
      description:
        'Return the Diversion working-tree status for a repo: branch, commit ID, sync state, ' +
        'and the list of changed files (modified / added / deleted / renamed) plus any sync ' +
        'conflicts. Diversion is a different VCS than git; do NOT use git tools on Diversion repos.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
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
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_diff',
    {
      title: 'Diversion: working-tree unified diff',
      description:
        'Return the unified diff of the working tree against the base commit, optionally ' +
        'scoped to one or more paths. Use this to inspect what the user changed before ' +
        'generating a commit message or reviewing their work.',
      inputSchema: {
        ...repoArg,
        paths: z.array(z.string()).optional().describe(
          'Optional list of repo-relative file or directory paths to scope the diff to. ' +
          'Omit to diff the entire working tree.',
        ),
      },
    },
    safe(registry, async (args, repo) => {
      const diff = await repo.unifiedDiff(args.paths);
      return text(diff.trim() || '(no working-tree differences)');
    }),
  );

  server.registerTool(
    'dv_diff_refs',
    {
      title: 'Diversion: diff between two refs',
      description:
        'Return the unified diff between two refs (commits, branches, or tags). Use this ' +
        'to compare branches or see what changed between two commits.',
      inputSchema: {
        ...repoArg,
        base: z.string().describe('The base ref (commit / branch / tag).'),
        compare: z.string().describe('The ref to compare against base.'),
      },
    },
    safe(registry, async (args, repo) => {
      const diff = await repo.diffBetween(nonEmpty('base', args.base), nonEmpty('compare', args.compare));
      return text(diff.trim() || '(no differences between refs)');
    }),
  );

  server.registerTool(
    'dv_log',
    {
      title: 'Diversion: commit log',
      description:
        'Return recent commits on the current branch with full message bodies, author, ' +
        'date, and any branch refs at each commit. Supports date filtering via `since` / ' +
        '`until` (ISO date or relative like "1 week ago").',
      inputSchema: {
        ...repoArg,
        limit: z.number().int().min(1).max(1000).optional()
          .describe('Maximum number of commits. Default 20, max 1000.'),
        since: z.string().optional().describe('Show commits after this date (ISO or relative).'),
        until: z.string().optional().describe('Show commits before this date (ISO or relative).'),
      },
    },
    safe(registry, async (args, repo) => {
      const opts: { limit?: number; since?: string; until?: string } = {
        limit: args.limit ?? 20,
      };
      if (args.since) opts.since = args.since;
      if (args.until) opts.until = args.until;
      const commits = await repo.logFiltered(opts);
      if (commits.length === 0) return text('(no commits)');
      const blocks = commits.map((c) => {
        const refs = c.refs.length > 0 ? ` (${c.refs.join(', ')})` : '';
        const indented = c.message.replace(/\n/g, '\n  ');
        return `${c.id}${refs}\n  ${c.authorName} <${c.authorEmail}>  ${c.date}\n  ${indented}`;
      });
      return text(blocks.join('\n\n'));
    }),
  );

  server.registerTool(
    'dv_file_history',
    {
      title: 'Diversion: per-file commit history',
      description:
        'Return commits that touched a specific file or directory. Equivalent to ' +
        '`git log -- <path>`. Use this when the user asks "who changed file X" or ' +
        '"when was Y last modified". Supports date filtering via `since` / `until`.',
      inputSchema: {
        ...repoArg,
        path: z.string().describe('Repo-relative file or directory path.'),
        limit: z.number().int().min(1).max(1000).optional()
          .describe('Maximum commits to return. Default 20, max 1000.'),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    safe(registry, async (args, repo) => {
      const opts: { path: string; limit?: number; since?: string; until?: string } = {
        path: nonEmpty('path', args.path),
        limit: args.limit ?? 20,
      };
      if (args.since) opts.since = args.since;
      if (args.until) opts.until = args.until;
      const commits = await repo.logFiltered(opts);
      if (commits.length === 0) return text(`(no commits touch ${args.path})`);
      const blocks = commits.map((c) => {
        const refs = c.refs.length > 0 ? ` (${c.refs.join(', ')})` : '';
        const indented = c.message.replace(/\n/g, '\n  ');
        return `${c.id}${refs}\n  ${c.authorName} <${c.authorEmail}>  ${c.date}\n  ${indented}`;
      });
      return text(blocks.join('\n\n'));
    }),
  );

  server.registerTool(
    'dv_overlapping_commits',
    {
      title: 'Diversion: commits touching my dirty paths',
      description:
        'Return recent commits on the current branch that touched the SAME paths the ' +
        'user has uncommitted working-tree changes in. This is the "what might conflict ' +
        'with my work" awareness signal — use it before committing or before suggesting ' +
        'a merge to surface where the user\'s changes overlap with other recent activity.',
      inputSchema: {
        ...repoArg,
        lookback: z.number().int().min(1).max(500).optional()
          .describe('How many recent commits to scan. Default 50, max 500.'),
        since: z.string().optional().describe('Only consider commits after this date.'),
      },
    },
    safe(registry, async (args, repo) => {
      const opts: { lookback?: number; since?: string } = {
        lookback: args.lookback ?? 50,
      };
      if (args.since) opts.since = args.since;
      const matches = await repo.overlappingCommits(opts);
      if (matches.length === 0) {
        return text('(no recent commits touch the paths you have working changes in)');
      }
      const blocks = matches.map(({ commit, touched }) => {
        const refs = commit.refs.length > 0 ? ` (${commit.refs.join(', ')})` : '';
        const subject = commit.message.split('\n', 1)[0] ?? '';
        const paths = touched.map((p) => `    - ${p}`).join('\n');
        return `${commit.id}${refs}  ${commit.authorName}  ${commit.date}\n  ${subject}\n  Overlapping paths (${touched.length}):\n${paths}`;
      });
      return text(blocks.join('\n\n'));
    }),
  );

  server.registerTool(
    'dv_show',
    {
      title: 'Diversion: show commit details',
      description:
        'Return full details for a single commit: author, date, message, refs, and the ' +
        'list of files it changed.',
      inputSchema: {
        ...repoArg,
        commit: z.string().describe('Commit ID (e.g. "dv.commit.42").'),
      },
    },
    safe(registry, async (args, repo) => {
      const commitId = nonEmpty('commit', args.commit);
      const [details, changes] = await Promise.all([
        repo.showCommit(commitId),
        repo.fileChangesForCommit(commitId).catch(() => []),
      ]);
      if (!details) return errText(`No commit found for "${commitId}".`);
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
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_branches',
    {
      title: 'Diversion: list branches',
      description:
        'List every branch in the repo with its tip commit. The currently checked-out ' +
        'branch is marked with a leading "*".',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const branches = await repo.listBranches();
      if (branches.length === 0) return text('(no branches)');
      const current = repo.info.branchName;
      const lines = branches.map((b) =>
        `${b.name === current ? '* ' : '  '}${b.name}  ${b.commitId}`,
      );
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_shelves',
    {
      title: 'Diversion: list shelves',
      description: 'List every shelf saved in the repo with its description / metadata.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const shelves = await repo.listShelves();
      if (shelves.length === 0) return text('(no shelves)');
      const lines = shelves.map((s) => {
        const id = s.id ? `${s.id}  ` : '';
        const desc = s.description ? `  — ${s.description}` : '';
        return `${id}${s.name}${desc}`;
      });
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_list_tags',
    {
      title: 'Diversion: list tags',
      description:
        'List every tag in the repo with its commit pointer and description. Backed by ' +
        '`dv tag --json` so the output is reliable across dv versions.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const tags = await repo.listTags();
      if (tags.length === 0) return text('(no tags)');
      const lines = tags.map((t) => {
        const commit = t.commitId ? ` → ${t.commitId}` : '';
        const desc = t.description ? `  — ${t.description}` : '';
        return `${t.id}  ${t.name}${commit}${desc}`;
      });
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_list_cloud_repos',
    {
      title: 'Diversion: list cloud-accessible repos',
      description:
        'List repositories the authenticated dv account has access to, partitioned into ' +
        'locally-cloned vs remote. Different from `dv_list_repos` which returns repos ' +
        'this MCP server has registered. Useful for discovery before cloning.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const repos = await repo.listCloudRepos();
      if (repos.length === 0) return text('(no repos accessible to this account)');
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
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_show_shelf',
    {
      title: 'Diversion: show shelf contents',
      description: 'Show the changes contained in a single shelf (raw dv output).',
      inputSchema: {
        ...repoArg,
        shelf: z.string().describe('Shelf name or ID.'),
      },
    },
    safe(registry, async (args, repo) => {
      const out = await repo.showShelf(nonEmpty('shelf', args.shelf));
      return text(out.trim() || '(shelf is empty)');
    }),
  );

  server.registerTool(
    'dv_locks',
    {
      title: 'Diversion: list hard locks',
      description:
        'List every hard lock visible to the workspace, with holder if known. Use this ' +
        'before editing binary assets that may be exclusively locked.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const locks = await repo.listLocks();
      if (locks.length === 0) return text('(no active locks)');
      const lines = locks.map((l) => {
        const holder = l.holder ? `  held by ${l.holder}` : '';
        return `${l.path}${holder}`;
      });
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'dv_annotate',
    {
      title: 'Diversion: per-line blame',
      description:
        'Return per-line attribution (commit / author / date) for a single text file in ' +
        'the workspace. Equivalent to `git blame`.',
      inputSchema: {
        ...repoArg,
        path: z.string().describe('Repo-relative path to the file.'),
      },
    },
    safe(registry, async (args, repo) => {
      const lines = await repo.annotate(nonEmpty('path', args.path));
      if (lines.length === 0) return text('(no annotation lines)');
      const out: string[] = [];
      for (const a of lines) {
        const id = a.uncommitted ? 'uncommitted' : (a.commitId ?? '?');
        const author = a.author ?? '?';
        const date = a.date ?? '?';
        out.push(`${id.padEnd(20)} ${author.padEnd(24)} ${date}  ${a.lineNumber.toString().padStart(5)}) ${a.content}`);
      }
      return text(out.join('\n'));
    }),
  );

  server.registerTool(
    'dv_open_merges',
    {
      title: 'Diversion: list unresolved merges',
      description:
        'List merges parked on conflicts, waiting for per-block resolution in the ' +
        'Diversion app. Distinct from `.dv-conflict` sidecar files, which are sync ' +
        'conflicts on disk and appear in dv_status.',
      inputSchema: { ...repoArg },
      annotations: { readOnlyHint: true },
    },
    safe(registry, async (_args, repo) => {
      const merges = await repo.listOpenMerges();
      if (merges.length === 0) return text('No unresolved merges.');
      return text(merges
        .map((m) => `${m.id}\t${m.otherRef} → ${m.baseRef}${m.startedBy ? `\t(${m.startedBy})` : ''}`)
        .join('\n'));
    }),
  );

  server.registerTool(
    'dv_merge_conflicts',
    {
      title: 'Diversion: conflicts in an open merge',
      description:
        'List the conflicting paths in one open merge, with whether each is resolved ' +
        'and which side won. Get the merge ID from dv_open_merges. Resolution itself ' +
        'is interactive and happens in the editor or the Diversion app.',
      inputSchema: {
        ...repoArg,
        merge: z.string().describe('Merge ID from dv_open_merges.'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(registry, async (args, repo) => {
      const merge = await repo.getMerge(nonEmpty('merge', args.merge));
      if (merge.conflicts.length === 0) return text(`Merge ${merge.id} reports no conflicts.`);
      const lines = [`${merge.otherRef} → ${merge.baseRef} (${merge.id})`, ''];
      for (const c of merge.conflicts) {
        const state = c.resolved ? `resolved${c.resolvedSide ? ` (${c.resolvedSide})` : ''}` : 'UNRESOLVED';
        lines.push(`${state.padEnd(20)} ${c.path}`);
      }
      return text(lines.join('\n'));
    }),
  );

  // ─── write tools ─────────────────────────────────────────────────────
  // Everything below mutates repository or workspace state. In read-only
  // mode we stop here so none of it is registered or reachable.
  if (opts.readOnly) return;

  server.registerTool(
    'dv_commit',
    {
      title: 'Diversion: commit changes',
      description:
        'Commit working-tree changes. Pass `paths` to commit a subset; omit for everything. ' +
        'The commit message is required.',
      inputSchema: {
        ...repoArg,
        message: z.string().describe('Commit message (required).'),
        paths: z.array(z.string()).optional()
          .describe('Optional repo-relative paths to limit the commit to. Omit for all changes.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(registry, async (args, repo) => {
      const msg = nonEmpty('message', args.message);
      await repo.commit(msg, args.paths);
      await repo.notifySyncRequired().catch(() => undefined);
      return text(`Commit created on ${repo.info.branchName || '<branch>'}.`);
    }),
  );

  server.registerTool(
    'dv_create_branch',
    {
      title: 'Diversion: create branch',
      description: 'Create a new branch. By default switches to the new branch.',
      inputSchema: {
        ...repoArg,
        name: z.string().describe('New branch name.'),
        switchTo: z.boolean().optional()
          .describe('Switch to the new branch (default true).'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.createBranch(nonEmpty('name', args.name), args.switchTo ?? true);
      return text(`Branch "${args.name}" created${args.switchTo === false ? '' : ' and checked out'}.`);
    }),
  );

  server.registerTool(
    'dv_delete_branch',
    {
      title: 'Diversion: delete a branch',
      description:
        'Delete a branch. The default branch cannot be deleted. The branch may be ' +
        'identified by name or ID.',
      inputSchema: {
        ...repoArg,
        branch: z.string().describe('Branch name or ID to delete.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      const name = nonEmpty('branch', args.branch);
      await repo.deleteBranch(name);
      return text(`Branch "${name}" deleted.`);
    }),
  );

  server.registerTool(
    'dv_rename_branch',
    {
      title: 'Diversion: rename a branch',
      description: 'Rename an existing branch.',
      inputSchema: {
        ...repoArg,
        branch: z.string().describe('Current branch name or ID.'),
        newName: z.string().describe('New branch name.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.renameBranch(nonEmpty('branch', args.branch), nonEmpty('newName', args.newName));
      return text(`Branch renamed to "${args.newName}".`);
    }),
  );

  server.registerTool(
    'dv_checkout',
    {
      title: 'Diversion: checkout a ref',
      description:
        'Check out a branch, tag, or commit. Use `takeChanges` / `shelveChanges` / ' +
        '`discardChanges` to control what happens to uncommitted working-tree changes ' +
        '(only one may be true). Shelved changes on the target branch are left ' +
        'shelved unless `applyShelf` is true.',
      inputSchema: {
        ...repoArg,
        ref: z.string().describe('Branch name, tag, or commit ID.'),
        takeChanges: z.boolean().optional(),
        shelveChanges: z.boolean().optional(),
        discardChanges: z.boolean().optional(),
        applyShelf: z.boolean().optional()
          .describe('Un-shelve the target branch\'s shelved changes after checkout.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
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
      return text(`Checked out "${ref}".`);
    }),
  );

  server.registerTool(
    'dv_merge',
    {
      title: 'Diversion: merge a ref into the current branch',
      description:
        'Merge the given ref into the currently checked-out branch. On conflicts the ' +
        'merge is parked server-side rather than failing, so this reports whether the ' +
        'merge completed or needs per-block resolution in the Diversion app. Note the ' +
        'conflict strategy is `keep-destination` here, not `keep-current` as in dv_revert.',
      inputSchema: {
        ...repoArg,
        ref: z.string().describe('Branch / tag / commit to merge into the current branch.'),
        conflictResolution: z.enum(['manual', 'keep-destination', 'accept-incoming']).optional()
          .describe('How to resolve conflicts. Default `manual` parks the merge for the app.'),
      },
    },
    safe(registry, async (args, repo) => {
      const ref = nonEmpty('ref', args.ref);
      await repo.merge(ref, args.conflictResolution);
      const parked = await repo.listOpenMerges().catch(() => []);
      if (parked.length > 0) {
        return text(
          `Merge of "${ref}" stopped on conflicts; ${parked.length} unresolved merge(s) ` +
          `(${parked.map((m) => m.id).join(', ')}). Conflicting blocks must be resolved in ` +
          `the Diversion app — there is no filesystem representation to edit.`,
        );
      }
      return text(`Merged "${ref}" into ${repo.info.branchName || '<branch>'}.`);
    }),
  );

  server.registerTool(
    'dv_cherry_pick',
    {
      title: 'Diversion: cherry-pick a commit',
      description: 'Apply the changes of a single past commit on top of the current branch.',
      inputSchema: {
        ...repoArg,
        commit: z.string().describe('Commit ID to cherry-pick.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.cherryPick(nonEmpty('commit', args.commit));
      return text(`Cherry-picked ${args.commit}.`);
    }),
  );

  server.registerTool(
    'dv_revert_commit',
    {
      title: 'Diversion: revert a past commit',
      description:
        'Create a new commit that inverts the changes of a past commit. Does not rewrite ' +
        'history. Optional `conflictResolution` controls how merge conflicts during revert ' +
        'are handled.',
      inputSchema: {
        ...repoArg,
        commit: z.string().describe('Commit ID to revert.'),
        conflictResolution: z.enum(['manual', 'keep-current', 'accept-incoming']).optional(),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.revertCommit(nonEmpty('commit', args.commit), args.conflictResolution);
      return text(`Reverted ${args.commit}.`);
    }),
  );

  server.registerTool(
    'dv_revert_to_commit',
    {
      title: 'Diversion: restore workspace to a past commit',
      description:
        'Set the workspace contents to match a given commit. Does NOT rewrite history; ' +
        'this creates a new commit reflecting the rolled-back state.',
      inputSchema: {
        ...repoArg,
        commit: z.string().describe('Commit ID to restore the workspace to.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      await repo.revertToCommit(nonEmpty('commit', args.commit));
      return text(`Workspace restored to ${args.commit}.`);
    }),
  );

  server.registerTool(
    'dv_restore_path',
    {
      title: 'Diversion: restore a path from a ref',
      description: 'Overwrite a single file in the working tree with its contents from a given ref.',
      inputSchema: {
        ...repoArg,
        ref: z.string().describe('Ref to source the file from (branch / tag / commit).'),
        path: z.string().describe('Repo-relative path to restore.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      await repo.restorePath(nonEmpty('ref', args.ref), nonEmpty('path', args.path));
      return text(`Restored ${args.path} from ${args.ref}.`);
    }),
  );

  server.registerTool(
    'dv_discard_path',
    {
      title: 'Diversion: discard working-tree changes to a path',
      description: 'Discard uncommitted changes to a single workspace-relative path.',
      inputSchema: {
        ...repoArg,
        path: z.string().describe('Repo-relative path whose changes to discard.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      await repo.discardPath(nonEmpty('path', args.path));
      return text(`Discarded changes to ${args.path}.`);
    }),
  );

  server.registerTool(
    'dv_discard_all',
    {
      title: 'Diversion: discard ALL working-tree changes',
      description:
        'Discard every uncommitted change in the workspace. If `includeNew` is true, also ' +
        'remove newly-added (untracked) files.',
      inputSchema: {
        ...repoArg,
        includeNew: z.boolean().optional()
          .describe('Also delete newly-added files (default false).'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      await repo.discardAll(args.includeNew ?? false);
      return text(`Discarded all working-tree changes${args.includeNew ? ' (including new files)' : ''}.`);
    }),
  );

  server.registerTool(
    'dv_create_tag',
    {
      title: 'Diversion: create a tag',
      description:
        'Create a tag at a specific commit, or at the current commit if `commit` is omitted. ' +
        'Optional `description` attaches a message to the tag.',
      inputSchema: {
        ...repoArg,
        name: z.string().describe('Tag name.'),
        commit: z.string().optional().describe('Commit to tag (defaults to current commit).'),
        description: z.string().optional().describe('Optional tag description.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.createTag(nonEmpty('name', args.name), args.commit, args.description);
      return text(`Tag "${args.name}" created${args.commit ? ` at ${args.commit}` : ''}.`);
    }),
  );

  server.registerTool(
    'dv_modify_tag',
    {
      title: 'Diversion: rename or re-describe a tag',
      description:
        'Rename a tag and/or replace its description. Keyed on the tag ID ' +
        '(`dv.tag.<n>`) from dv_list_tags, NOT the tag name. Pass at least one of ' +
        '`name` / `description`.',
      inputSchema: {
        ...repoArg,
        tag: z.string().describe('Tag ID, e.g. dv.tag.3 (from dv_list_tags).'),
        name: z.string().optional().describe('New tag name.'),
        description: z.string().optional().describe('New tag description. Pass "" to clear.'),
      },
    },
    safe(registry, async (args, repo) => {
      const tag = nonEmpty('tag', args.tag);
      const opts: { name?: string; description?: string } = {};
      if (args.name !== undefined) opts.name = args.name;
      if (args.description !== undefined) opts.description = args.description;
      await repo.modifyTag(tag, opts);
      return text(`Tag ${tag} updated.`);
    }),
  );

  server.registerTool(
    'dv_delete_tag',
    {
      title: 'Diversion: delete a tag',
      description:
        'Delete a tag. Keyed on the tag ID (`dv.tag.<n>`) from dv_list_tags, NOT the tag name.',
      inputSchema: {
        ...repoArg,
        tag: z.string().describe('Tag ID, e.g. dv.tag.3 (from dv_list_tags).'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      const tag = nonEmpty('tag', args.tag);
      await repo.deleteTag(tag);
      return text(`Tag ${tag} deleted.`);
    }),
  );

  server.registerTool(
    'dv_create_shelf',
    {
      title: 'Diversion: create a shelf',
      description:
        'Shelve working-tree changes under a name. If `paths` is supplied only those are ' +
        'shelved; otherwise all changes. Set `keepWorkingChanges` to keep the working tree ' +
        'intact (otherwise it is reset after shelving).',
      inputSchema: {
        ...repoArg,
        name: z.string().describe('Shelf name.'),
        paths: z.array(z.string()).optional(),
        keepWorkingChanges: z.boolean().optional(),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.createShelf(nonEmpty('name', args.name), args.paths, args.keepWorkingChanges ?? false);
      return text(`Shelf "${args.name}" created.`);
    }),
  );

  server.registerTool(
    'dv_apply_shelf',
    {
      title: 'Diversion: apply a shelf',
      description: 'Apply a shelved changeset on top of the working tree.',
      inputSchema: {
        ...repoArg,
        shelf: z.string().describe('Shelf name or ID.'),
        keepShelfAfter: z.boolean().optional()
          .describe('Keep the shelf after applying (default false — shelf is consumed).'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.applyShelf(nonEmpty('shelf', args.shelf), args.keepShelfAfter ?? false);
      return text(`Applied shelf "${args.shelf}".`);
    }),
  );

  server.registerTool(
    'dv_delete_shelf',
    {
      title: 'Diversion: delete a shelf',
      description: 'Delete a shelf permanently.',
      inputSchema: {
        ...repoArg,
        shelf: z.string().describe('Shelf name or ID.'),
      },
      annotations: { destructiveHint: true },
    },
    safe(registry, async (args, repo) => {
      await repo.deleteShelf(nonEmpty('shelf', args.shelf));
      return text(`Shelf "${args.shelf}" deleted.`);
    }),
  );

  server.registerTool(
    'dv_rename_shelf',
    {
      title: 'Diversion: rename a shelf',
      description: 'Rename an existing shelf.',
      inputSchema: {
        ...repoArg,
        shelf: z.string().describe('Current shelf name or ID.'),
        newName: z.string().describe('New shelf name.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.renameShelf(nonEmpty('shelf', args.shelf), nonEmpty('newName', args.newName));
      return text(`Shelf renamed to "${args.newName}".`);
    }),
  );

  server.registerTool(
    'dv_lock_path',
    {
      title: 'Diversion: acquire a hard lock',
      description:
        'Acquire a hard lock on a path so other users cannot modify it. Requires a Studio ' +
        'or Enterprise subscription on the repo.',
      inputSchema: {
        ...repoArg,
        path: z.string().describe('Repo-relative path to lock.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.lockPath(nonEmpty('path', args.path));
      return text(`Locked ${args.path}.`);
    }),
  );

  server.registerTool(
    'dv_unlock_path',
    {
      title: 'Diversion: release a hard lock',
      description: 'Release a hard lock previously acquired on a path.',
      inputSchema: {
        ...repoArg,
        path: z.string().describe('Repo-relative path to unlock.'),
      },
    },
    safe(registry, async (args, repo) => {
      await repo.unlockPath(nonEmpty('path', args.path));
      return text(`Unlocked ${args.path}.`);
    }),
  );

  server.registerTool(
    'dv_pause_sync',
    {
      title: 'Diversion: pause background sync',
      description: 'Pause the agent\'s background sync for the workspace (like working offline).',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      await repo.pauseSync();
      return text(`Sync paused for ${repo.info.repoName}.`);
    }),
  );

  server.registerTool(
    'dv_resume_sync',
    {
      title: 'Diversion: resume background sync',
      description: 'Resume the agent\'s background sync for the workspace.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      await repo.resumeSync();
      return text(`Sync resumed for ${repo.info.repoName}.`);
    }),
  );

  server.registerTool(
    'dv_update_workspace',
    {
      title: 'Diversion: pull base branch updates',
      description:
        'Force-pull the workspace\'s base branch. Useful when auto-update is off or you ' +
        'want to update immediately rather than waiting on the agent.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      await repo.updateWorkspace();
      await repo.refreshIdentity().catch(() => undefined);
      return text(`Workspace updated. Now on commit ${repo.info.commitId || '<unknown>'}.`);
    }),
  );

  server.registerTool(
    'dv_verify',
    {
      title: 'Diversion: verify repository integrity',
      description: 'Run dv\'s built-in integrity verification on the repo.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      const out = await repo.verify();
      return text(out.trim() || '(verify produced no output)');
    }),
  );

  server.registerTool(
    'dv_open_in_web',
    {
      title: 'Diversion: open the workspace in the web UI',
      description:
        'Spawn `dv view` to open the workspace in the Diversion web UI. Fire-and-forget — ' +
        'returns immediately. Requires a browser on the same host as the dv CLI.',
      inputSchema: { ...repoArg },
    },
    safe(registry, async (_args, repo) => {
      await repo.openInWeb();
      return text(`Opened ${repo.info.repoName} in the web UI.`);
    }),
  );
}
