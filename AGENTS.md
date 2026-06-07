# AGENTS.md

Orientation for AI/coding agents working on this repo. Skim this before
making changes; the file is short on purpose.

## What this is

A VS Code extension that registers [Diversion](https://www.diversion.dev)
as a first-class SCM provider. TypeScript, bundled with esbuild,
targets VS Code ≥ 1.93. Coexists with the built-in Git provider.

The extension is **not** a Diversion-Inc product — it talks to Diversion's
documented local agent (the `dv` daemon's HTTP surface) and the `dv` CLI
on the user's machine. We **do not** call Diversion's cloud API directly
(`api.diversion.dev`) because that requires being a registered client,
and we aren't.

## ⚠️ Two source-control systems live here, don't confuse them

- **This repo** is on **git** (GitHub: `mtuska/diversion-vscode`).
  Use normal `git` commands for development. Releases are tagged
  `vX.Y.Z` on `main` and a GitHub Action builds the `.vsix`.
- **The repos this extension targets** are Diversion (`dv`) workspaces.
  When you run the extension under F5 / Extension Development Host,
  it's looking at `dv`-managed folders, not git ones.

If a tool or skill mentions "diversion" or "dv", that's about the *target*
of the extension, not this repo's own VCS. Don't `dv commit` your changes
to this codebase — that would commit to whatever Diversion workspace you
happened to have open in the dev host.

## Layout

```
src/
  extension.ts          Activation, scanning workspace folders, command wiring,
                        editor-event fast paths (save/create/delete/rename).
                        ~1700 LOC; commands live here as top-level functions.
  diversion/
    daemon.ts           HTTP client for the local dv sync agent (AgentAPI).
                        Endpoints: /health, /workspaces, /workspace?abs_path,
                        /repo/{}/workspace/{}/sync (+/progress), /files/status.
    cli.ts              Spawn-`dv` wrapper. Concurrency-bounded via semaphore.
    repo.ts             Per-repo facade. Holds identity; reads via CoreAPI,
                        writes via CLI; exposes high-level ops (commit, diff,
                        log, branches…).
    coreApi.ts          CoreApiClient — typed cloud CoreAPI client. Token from
                        daemon.coreToken() (cached in memory). Source of truth
                        for status, branches, log, compare, shelves, repos.
    detect.ts           findDiversionRoot (upward walk), findNestedDiversionRoots
                        (downward, depth-bounded — the multi-repo case),
                        detectRepo (tries daemon first, FS fallback).
    settings.ts         Read user-configurable settings.
    types.ts            Wire types — RepoIdentity, FileChange, domain types
                        (CommitDetails, BranchInfo…), AgentAPI + CoreAPI shapes.
    parsers/            Text parsers for the few `dv` outputs with no API:
                        lock (locks), annotate (blame), tag (already JSON),
                        unifiedDiff (display renderer). Unit-tested under
                        test/unit/parsers/.
    conflicts.ts        Detection of `*.dv-conflict*` sidecar files.
    reverseApply.ts     Discard helpers.
  scm/
    provider.ts         DiversionScmProvider — implements vscode.SourceControl.
                        doRefresh pulls changed paths from the CoreAPI
                        (repo.getState), coalesces concurrent refreshes via
                        `inFlight`.
    historyProvider.ts  Source Control Graph integration. Fires
                        notifyCurrentChanged + notifyRefsChanged on commit.
    changeDecorations.ts FileDecorationProvider for M/A/D/R + ancestor
                        folders + ignored files. Computes ancestor sets so
                        collapsed parents in the explorer get badges without
                        VS Code's lazy-propagate cache.
    lockDecorations.ts  🔒 badge + errorForeground tint for `dv lock`-held files.
    quickDiff.ts        TextDocumentContentProvider for the inline diff gutter.
    commitContent.ts    `dv-commit:<id>:<path>` content provider (lazy
                        `dv diff --base` per file, cached).
    blame.ts            Line-blame from `dv annotate`.
    shelvesView.ts      TreeView for `dv shelf`.
  ui/
    statusBar.ts        Branch + sync indicator. Self-polls /sync/progress
                        while syncing.
    webviews/log.ts     "View commit history" webview.
  ai/
    tools.ts            vscode.lm tool definitions (status/diff/log/branches)
                        so Copilot Chat can inspect SCM state.
  util/
    ignore.ts           IgnoreManager: .dvignore (lenient mid-slash semantics)
                        + .gitignore (strict). Computes "fully-ignored dirs"
                        via post-order scan.
    fsWatch.ts          createFileSystemWatcher wrapper, ignores .diversion/
                        .git/.vscode/swap files.
    semaphore.ts        Caps concurrent dv processes (configurable).
    path.ts             pathEquals + isInsideOrEqual that handle
                        case-insensitivity / symlink-canonicalised home dirs.
    walk.ts, log.ts, binary.ts
test/unit/              Vitest. Parser-heavy.
unreal/                 (Untracked) Reference copy of Diversion's Unreal
                        plugin for OpenAPI inspection. **Never commit this.**
                        Don't add it to .gitignore either.
```

## Activation flow

1. `extension.ts:activate` — instantiates singletons (Logger, StatusBar,
   ChangeDecorationsProvider, LockDecorationProvider, QuickDiff, Blame…),
   registers them as VS Code subscriptions, registers commands.
2. `scanWorkspaceFolders()` — for each VS Code workspace folder:
   - Upward walk for `.diversion/` → `detectRepo`.
   - Downward scan up to `repositoryScanMaxDepth` (default 1) for nested
     Diversion repos.
   - For each found repo: instantiate `Repo` + `DiversionScmProvider` +
     `IgnoreManager`. `setOpenFolders(...)` lets the SCM panel filter to
     the user's actual subfolder selection.
   - Wire one `watchWorkspace` per open folder.
3. Editor events (`onDidSaveTextDocument` etc.) route through
   `onDocumentMutated` for **zero-debounce** SCM refresh — this is the
   fast path. The FS watcher path (default 150ms debounce) only matters
   for external file changes (build outputs, format-on-save, etc.).
4. Status bar self-polls `/sync/progress` while the agent reports
   `IsSyncComplete: false`.

## How SCM refresh works

`DiversionScmProvider.scheduleRefresh(debounceMs)` debounces, then
`refresh()` coalesces concurrent calls via `inFlight` + `pendingRefresh`.
`doRefresh()` does:

1. `Promise.all([repo.getState(), repo.refreshIdentity()])`
2. Prune stale staged paths (whose changes vanished).
3. Walk `state.changes` once: populate decorationStates **for the whole
   repo** but only push to SCM groups what passes `isPathVisible` (the
   open-folder filter).
4. Push groups, update title buttons, fire history events.
5. Compare commitId/branchName vs the snapshot taken at start; on
   change, fire `notifyRefsChanged({ modified: [currentRef] })` so the
   graph re-queries.

The `setRepoState` in [`changeDecorations.ts`](src/scm/changeDecorations.ts)
also computes ancestor directories of every changed file and fires
decoration-change events for them. We don't rely on VS Code's
`propagate: true` alone because it only propagates to ancestors VS Code
has already queried — collapsed folders never get badges that way.

## CLI vs AgentAPI: which to use for new work

Prefer **AgentAPI (HTTP, no auth, local)** for anything that's about the
agent's own state:

- workspace identity / sync status / sync progress / file-sync status
- workspace-by-path lookup (one round trip, no client-side scan)
- nudging the agent to re-scan (`notifySyncRequired`)

Use **`dv` CLI** for anything the AgentAPI doesn't expose: branches,
tags, shelves, locks, log, blame, merge, commit, reset, revert, update,
init.

**Do not** introduce calls to `api.diversion.dev` (CoreAPI). It's
JWT-authenticated against Diversion's cloud and we're not a registered
client. The trade-off is documented in the v0.3.x → v0.4.0 design notes
in commit history.

## Commands

VS Code-side commands are registered in [`extension.ts`](src/extension.ts)
under the big `context.subscriptions.push(... registerCommand(...) ...)`
block. The package.json `commands` array must mirror them.

Menu wiring lives in `package.json` under `contributes.menus`:
- `scm/title` — toolbar buttons on the SCM panel header.
- `scm/sourceControl` — repo-level context menu.
- `scm/inputBox` — buttons next to the commit message (sparkle ✨).
- `scm/resourceGroup/context` — group rows (Changes / Staged / Conflicts).
- `scm/resourceFolder/context` — folder rows in tree view (`v0.3.22+`).
- `scm/resourceState/context` — individual file rows.

Folder-row commands receive a folder `Uri`; group-row commands receive a
`SourceControlResourceGroup`; file-row commands receive
`SourceControlResourceState`. The `resolveResourceStates(args, group)`
helper in `extension.ts` accepts all three shapes — use it whenever a
command can be triggered from multiple menu locations.

## Conventions

**Coding style**

- TypeScript, ES modules (`.js` extension on relative imports because we
  emit ESM and esbuild handles them; **don't** strip the `.js`).
- No emojis in code or commits unless explicitly requested by the user.
- Comments are rare. Default to none. Add only when the *why* is
  non-obvious — a hidden constraint, a workaround for a specific bug,
  surprising behavior. Don't restate what the code says. Don't reference
  PR numbers, callers, or "fixes issue #X" — that rots.
- No backwards-compat shims for unused code. If something's unreachable,
  delete it.
- No `try { ... } catch { /* fallback */ }` for scenarios that can't
  happen. Trust internal callers.
- Be specific in identifiers and verbs. Prefer "scope to" over "limit",
  "drop" over "remove".

**Commits**

- Conventional Commits with a parenthesised scope when one fits:
  `fix(scm): ...`, `feat(detect): ...`, `perf(ignore): ...`. Subject
  ≤ 50 chars target, hard cap 72. Body wraps at 72.
- Body explains the *why* and the trade-off, not the diff. Bullet points
  with `- ` for multiple distinct changes; sub-headings for unrelated
  tracks of work. Never run-on prose like "Also: ..., ..., ...".
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
- Stage files explicitly. **Never** `git add -A` / `git add .` — the
  `unreal/` folder is locally-present reference material we never want
  to commit, and it is intentionally not in `.gitignore`.

**Versioning**

- Bump `version` in both `package.json` and `package-lock.json` (the
  root and the `.packages[""]` entry).
- Tag `vX.Y.Z` on `main`. Push `main` and the tag — the GitHub Action
  builds and attaches the `.vsix` to a GitHub Release.
- Patch bumps for fixes; minor for features; we're pre-1.0 so a minor
  bump (e.g. v0.3.x → v0.4.0) is fine even for non-breaking but
  meaningful changes.

**Pre-commit checks**

- `npm run typecheck` — must pass. Strict mode, no errors tolerated.
- `npm test` — Vitest unit tests (CoreAPI mappers + remaining parsers).
  ~46 tests, all should pass.
- No mandatory lint step today; if you add one, also wire it into CI.

**Don't surprise the user**

- Read-only verification (typecheck, tests, status, diff) is fine to run
  without asking.
- Local writes (edits, new files) are fine.
- Network actions (`git push`, GH operations, publishing the marketplace),
  destructive ops (`git reset --hard`, force-push, deleting branches),
  and anything that affects shared state — confirm first unless the
  current request explicitly authorised it.
- If asked to ship: bump version, commit, tag, and push are fine.
  Otherwise stop after the commit and ask.

## Common tasks

**Add a new command**

1. Function in `extension.ts` (top-level `async function fooCommand(...)`).
2. `vscode.commands.registerCommand('diversion.foo', fooCommand)` in the
   subscriptions block.
3. Entry in `package.json` `contributes.commands`. Add `enablement` if
   the command should grey out when no Diversion repo is active.
4. If it should appear in a menu: add to the relevant
   `contributes.menus` array with a `when` clause gating on
   `scmProvider == diversion`.

**Add a new read operation to `Repo`** (prefer the CoreAPI)

1. Add the wire type(s) in `types.ts` (snake_case, mirroring the JSON).
2. Method on `CoreApiClient` in `coreApi.ts` that calls `this.get(...)`
   and maps to a domain type. Add a Vitest unit test in
   `test/unit/coreApi.test.ts` with a stubbed daemon + mocked `fetch`.
3. Thin method on `Repo` delegating to `this.core`.
4. Only fall back to text-parsing the CLI when there is genuinely no
   CoreAPI endpoint (today: locks, blame). Treat `dv`'s text format as
   unstable; parsers are the single place that knows the layout.

**Add a new dv-CLI-backed write operation to `Repo`**

1. Method on `Repo` in `repo.ts` calling `runDvOrThrow([...args], {...})`.
   Writes stay on the CLI so the agent keeps sync state authoritative.

**Add a new AgentAPI endpoint**

1. Type for the wire shape in `types.ts`.
2. Method on `DaemonClient` in `daemon.ts` — use `getJson` for GET,
   `postNoBody` for fire-and-forget POST. Convert any 4xx to a
   sensible "no result" return (see `workspaceByPath`).
3. Surface through `Repo` if it's a per-repo concept; otherwise let
   callers use the daemon client directly.

**Add a Copilot Chat tool**

`src/ai/tools.ts` + `package.json` `contributes.languageModelTools`.
Both must declare the same name. Tools are read-only by convention.

## Sharp edges to know about

- **`dv`'s text output is the unstable surface.** When something parses
  oddly, look at the parser fixtures and the actual dv version on disk
  (`dv --version`). Diversion ships frequently and minor format shifts
  happen.
- **Daemon eventual consistency.** `dv commit` returns before the agent's
  registry reflects the new commitId. `commitCommand` polls
  `refreshIdentity()` for up to 2s; don't undo that or the SCM Graph
  shows the old commit briefly.
- **`.dvignore` mid-slash anchoring is lenient.** `Binaries/*` matches
  anywhere in the tree, not just at the root, even though gitignore
  spec says it should anchor. We rewrite mid-slash patterns to `**/...`
  at load time. `.gitignore` keeps strict semantics. See
  `unanchorPattern` in `util/ignore.ts`.
- **Open-folder filter affects SCM panel only, not decorations.** Every
  changed file in the repo gets a decoration entry; the panel listing
  is filtered. This is intentional — the explorer used to be empty
  outside the open subfolder.
- **`unreal/` exists locally as reference material** (the official
  Unreal plugin's source, including its OpenAPI yaml for AgentAPI). It
  must stay untracked AND must not be in `.gitignore` (the user wants
  the `?? unreal/` line to keep showing up in `git status` as a tactile
  reminder). Always stage files explicitly when committing.
- **VS Code's FileDecorationProvider doesn't auto-propagate to collapsed
  parents.** Compute ancestor decorations explicitly. See
  `computeAncestors` and `ancestorDecoration` in
  `scm/changeDecorations.ts`.
- **`detect.ts` `path.equals`** must handle macOS / Windows
  case-insensitivity *and* the Fedora Atomic `/home` → `/var/home`
  symlink. VS Code reports the un-canonicalised path; the daemon stores
  the canonical one. `pathEquals` and `canonicalize` cover this.

## Where to start

For a one-off fix: read [`README.md`](README.md), grep for the symptom,
trace through `extension.ts` → `provider.ts` → `repo.ts` as needed.

For a new feature: figure out which existing layer it belongs to (UI?
SCM provider? Repo facade? Daemon client?), keep changes scoped to that
layer plus its package.json wiring, run typecheck + tests, then ship.

If you're not sure, ask the user before sprawling across multiple
modules.
