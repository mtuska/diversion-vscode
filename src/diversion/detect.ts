import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathEquals } from '../util/path.js';
import type { DaemonClient } from './daemon.js';
import type { DaemonWorkspace, RepoIdentity } from './types.js';

/**
 * Walk up from `startDir` looking for a `.diversion` directory. Returns the
 * directory containing it, or undefined if no marker is found before the
 * filesystem root.
 *
 * This is the function that lets us activate when a user opens a *sub*-
 * directory of a Diversion repo (e.g. `code RepoRoot/Subdir`):
 * VS Code's `workspaceContains:.diversion` activation event matches only
 * children of the open folder, never ancestors, so the activate() function
 * uses this walk to find the actual repo root regardless of how the user
 * launched VS Code.
 */
export async function findDiversionRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  // Cap at 64 levels to avoid pathological symlink loops.
  for (let i = 0; i < 64; i++) {
    const marker = path.join(current, '.diversion');
    try {
      const st = await fs.stat(marker);
      if (st.isDirectory()) return current;
    } catch {
      // not present at this level, keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Walk *down* from `startDir` looking for nested `.diversion` folders, up
 * to `maxDepth` directory levels deep. Returns the absolute paths of
 * directories that contain a `.diversion/` marker, in discovery order.
 *
 * Used for "open a parent folder containing several Diversion repos and
 * have each repo register independently" — same shape as the built-in
 * git extension's `git.repositoryScanMaxDepth` behaviour.
 *
 * Depth semantics mirror git's: depth 0 disables the scan, depth 1 looks
 * one level under `startDir` (immediate children), depth 2 looks two
 * levels, and so on. Once a repo is found we stop descending into that
 * subtree — nested-inside-nested is rare and registering both would be
 * confusing.
 *
 * Skips: dotfile directories (`.git`, `.vscode`, etc.), `node_modules`,
 * symlinked directories (loop hazard), and unreadable directories.
 */
export async function findNestedDiversionRoots(
  startDir: string,
  maxDepth: number,
): Promise<string[]> {
  if (maxDepth <= 0) return [];
  const found: string[] = [];

  async function walk(dir: string, depthLeft: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === '.diversion' && e.isDirectory())) {
      found.push(dir);
      return;
    }

    if (depthLeft <= 0) return;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(path.join(dir, entry.name), depthLeft - 1);
    }
  }

  await walk(path.resolve(startDir), maxDepth);
  return found;
}

/**
 * Cross-reference a workspace folder path against the daemon's workspace
 * registry. Returns the matching DaemonWorkspace if any.
 *
 * Both sides are canonicalised via `fs.realpath` to handle symlinks
 * (e.g. /home → /var/home on Fedora Atomic), and compared via `pathEquals`
 * so Windows case-insensitivity and forward/back-slash mixing don't cause
 * false negatives (the daemon's stored path can disagree with what
 * `realpath` returns on either axis).
 */
export async function findRegisteredWorkspace(
  daemon: DaemonClient,
  workspaceRoot: string,
): Promise<DaemonWorkspace | undefined> {
  const workspaces = await daemon.workspaces();
  const target = await canonicalize(workspaceRoot);
  for (const ws of Object.values(workspaces)) {
    if (pathEquals(await canonicalize(ws.Path), target)) return ws;
  }
  return undefined;
}

async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Best-effort detection: prefer the daemon registry (authoritative when up),
 * fall back to a `.diversion/` directory walk if the daemon is unreachable.
 *
 * Returns the resolved RepoIdentity, or undefined if the folder is not a
 * Diversion workspace.
 *
 * The identity's `workspacePath` is always set to the **caller-supplied**
 * `workspaceRoot` (i.e. what VS Code reported), not the daemon's canonical
 * form. This matters on systems with symlinked home dirs (Fedora Atomic
 * mounts `/home` → `/var/home`): VS Code reports `/home/...`, the daemon
 * registers `/var/home/...`, and we need every URI we hand back to VS Code
 * to use *its* form so `TextDocumentContentProvider` lookups match.
 */
export async function detectRepo(
  daemon: DaemonClient,
  workspaceRoot: string,
): Promise<RepoIdentity | undefined> {
  const root = await findDiversionRoot(workspaceRoot);
  if (!root) return undefined;

  try {
    // Prefer the agent's direct lookup — one request, no client-side
    // walk of the full registry. Falls back to the registry scan if the
    // path lookup fails (older agents that pre-date that endpoint, or
    // a path-comparison miss against the daemon's stored form).
    const direct = await daemon.workspaceByPath(await canonicalize(root));
    if (direct) return identityFromDaemon(direct, root);
    const ws = await findRegisteredWorkspace(daemon, root);
    if (ws) return identityFromDaemon(ws, root);
  } catch {
    // Daemon unreachable — fall through to filesystem-only identity.
  }
  return identityFromFilesystem(root);
}

function identityFromDaemon(ws: DaemonWorkspace, workspacePath: string): RepoIdentity {
  return {
    workspaceId: ws.WorkspaceID,
    workspacePath,
    repoId: ws.RepoID,
    repoName: ws.RepoName,
    branchId: ws.BranchID,
    branchName: ws.BranchName,
    commitId: ws.CommitID,
    paused: ws.Paused,
    readOnly: ws.ReadOnly,
    tier: ws.OrganizationTier,
  };
}

/**
 * Filesystem fallback when the daemon is offline. Reads the workspace ID file
 * directly from `.diversion/dv.ws.<uuid>` so we at least know we're in a
 * workspace; richer fields (branch, commit, repo name) get filled in once the
 * daemon comes back.
 */
async function identityFromFilesystem(root: string): Promise<RepoIdentity | undefined> {
  const dotdir = path.join(root, '.diversion');
  let entries: string[];
  try {
    entries = await fs.readdir(dotdir);
  } catch {
    return undefined;
  }
  const wsFile = entries.find((e) => e.startsWith('dv.ws.'));
  if (!wsFile) return undefined;

  // Try parsing the JSON in that file for whatever we can salvage; structure
  // is not officially documented so we tolerate missing fields.
  const wsId = wsFile;
  let parsed: Partial<DaemonWorkspace> = {};
  try {
    const raw = await fs.readFile(path.join(dotdir, wsFile), 'utf8');
    parsed = JSON.parse(raw) as Partial<DaemonWorkspace>;
  } catch {
    // ignore — we still have the workspace ID
  }
  return {
    workspaceId: parsed.WorkspaceID ?? wsId,
    // Use the on-disk location we actually found `.diversion` in, NOT the
    // `Path` field from the marker file — that file can be committed into a
    // repo, so trusting it would let a cloned repo point the SCM provider,
    // conflict walks, and discard flows at an arbitrary directory.
    workspacePath: root,
    repoId: parsed.RepoID ?? '',
    repoName: parsed.RepoName ?? path.basename(root),
    branchId: parsed.BranchID ?? '',
    branchName: parsed.BranchName ?? '',
    commitId: parsed.CommitID ?? '',
    paused: parsed.Paused ?? false,
    readOnly: parsed.ReadOnly ?? false,
    tier: parsed.OrganizationTier ?? '',
  };
}
