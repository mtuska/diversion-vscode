# Diversion for VS Code

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/mtuska.diversion-vscode?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/mtuska.diversion-vscode)](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode)
[![Latest release](https://img.shields.io/github/v/release/mtuska/diversion-vscode?include_prereleases&sort=semver)](https://github.com/mtuska/diversion-vscode/releases/latest)
[![Release workflow](https://github.com/mtuska/diversion-vscode/actions/workflows/release.yml/badge.svg)](https://github.com/mtuska/diversion-vscode/actions/workflows/release.yml)
[![CI](https://github.com/mtuska/diversion-vscode/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/mtuska/diversion-vscode/actions/workflows/ci.yml)

Source-control integration for [Diversion](https://www.diversion.dev) — registers Diversion as a first-class SCM provider so you can commit, branch, diff, switch, and merge from inside VS Code.

> **Status: v0.4.x.** Available on the [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode). Tested against `dv v0.9.x` on VS Code 1.95+. Coexists peacefully with the built-in Git provider; activates whenever the open folder lives inside (or is) a Diversion-managed workspace.

## Requirements

- The `dv` CLI on your `PATH` (or set `diversion.path`). The extension
  defaults to `dv` on macOS / Linux and `dv.exe` on Windows.
- A workspace cloned with `dv clone` or initialized with `dv init`. The
  extension activates whenever the open folder is inside a Diversion repo
  — opening a sub-directory of a `.diversion/`-marked tree works too; we
  walk up to find the actual repo root.
- The Diversion daemon running locally (it is when `dv status` works).
- VS Code 1.95 or newer.

## Installing

### Option 1: VS Marketplace (recommended)

Install directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode), or from the command line:

```bash
code --install-extension mtuska.diversion-vscode
```

You can also search for **Diversion** in the VS Code Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).

### Option 2: install the latest `.vsix` from a release

Download the `.vsix` from the [Releases page](https://github.com/mtuska/diversion-vscode/releases),
then:

```bash
code --install-extension diversion-vscode-<version>.vsix
```

### Option 3: build from source

```bash
git clone https://github.com/mtuska/diversion-vscode.git
cd diversion-vscode
npm install
npm run package          # produces diversion-vscode-<version>.vsix
code --install-extension diversion-vscode-*.vsix
```

### Option 4: run unpacked from source (development)

```bash
git clone https://github.com/mtuska/diversion-vscode.git
cd diversion-vscode
npm install
npm run build            # or `npm run watch` for incremental rebuilds
```

Open the project folder in VS Code and press **F5**. A second VS Code
window opens with the extension loaded ("Extension Development Host").
Proposed APIs (the SCM Graph) are auto-enabled in this mode.

### Verifying

After installing, open a Diversion-managed folder. You should see:

- A **Diversion** entry in the **Source Control** view, with a branch pill
  next to the repo name and a `…` menu.
- The current branch in the bottom-left status bar.
- Output channel **Diversion** (View → Output → choose "Diversion") with
  an activation log line.

If nothing happens, run `Diversion: Show Daemon Health` from the command
palette — that's the first sanity check.

## Platform support

| Platform | dv binary default | Status |
|---|---|---|
| Linux   | `dv`     | Tested. Active development platform. |
| macOS   | `dv`     | Should work; same `dv` semantics as Linux. Untested. |
| Windows | `dv.exe` | Should work; path handling is sep-aware and Windows-tested. Untested with a real Windows dv install. |

If you hit a platform-specific issue, file it with the contents of the
`Diversion` output channel and we'll triage. The `Diversion: Run
Performance Trace` command's output is also useful — it tells us whether
the daemon and `dv` itself are responding the way we expect.

## Features

**Source Control panel**
- One **Diversion** provider per repo, keyed by the actual `.diversion/`
  ancestor — opening a sub-directory still registers correctly.
- Resource groups: **Conflicts**, **Staged Changes**, **Changes**, **New**.
  Conflicts (`*.dv-conflict.*` sidecars) surface automatically.
- Inline +/− buttons on every resource (stage / unstage), plus context-menu
  Stage / Unstage / Commit Selected / Discard. Multi-select works.
- Staging is persisted per-workspace via `workspaceState`, so it survives
  reloads.
- Commit picks the staged paths if any are staged, otherwise commits all
  (`dv commit <paths> -m` / `dv commit -a -m`).
- **Generate Commit Message** (sparkle button on the SCM input box) hands the
  current diff to your configured VS Code language model and drops the
  result into the commit message box.
- QuickDiff (gutter + side-by-side) via reverse-applied unified diff. Binary
  files skip the diff path and open directly.

**Repo header (per-repo `…` menu)**
- Branch pill (`$(git-branch) <name>`) — click to switch branches.
- Ellipsis button next to it opens a categorised quick-pick: Actions /
  Branch / Sync / Locks / View. Right-click on the repo row gets you the
  same menu.
- Sync verbs (no push/pull — Diversion auto-syncs commits): Update Workspace,
  Pause Sync, Resume Sync, Verify Repository.

**History**
- VS Code's built-in **Source Control Graph** populates with branches,
  commit timestamps, parents, and per-commit file lists. Clicking a file
  opens a real side-by-side diff for that commit (via a `dv-commit:`
  content scheme).
- **View History** webview as a textual fallback.
- **Cherry-pick / Revert / Restore-to-commit** commands.

**Game-dev specific**
- **Hard locks** (`dv lock`): 🔒 explorer badges via FileDecorationProvider,
  Lock / Unlock / List Locks commands. *Server-side gated to Studio /
  Enterprise tiers.*
- **Sync conflict resolution** for `*.dv-conflict.*` sidecars (a Diversion
  concept distinct from merge conflicts).
- **Shelves** tree view (`dv shelf`): create / apply / delete / rename plus
  Shelve-and-switch-branch.
- **Inline blame** (`dv annotate`) — `Diversion: Toggle Blame`. Block-grouped
  GitLens-style.

**Performance**
- Batched per-commit prefetch when the SCM Graph expands a commit (one
  `dv diff --base <commit>` call instead of N).
- Persistent on-disk cache for commit content (50 MB, mtime LRU, segmented
  by dv version) — re-opening the same commit's diffs is ~1 ms after the
  first session.
- `Diversion: Run Performance Trace` runs a known battery and writes
  per-step timings to the output channel, useful for triage.
- `diversion.maxParallelProcesses` caps concurrent `dv` invocations (default
  4). Bump it on fast machines to speed up SCM Graph prefetch.

**Language Model Tools**

Exposes four read-only tools to GitHub Copilot Chat and any other VS Code
language-model client, so the model can answer questions about your
Diversion workspace without you copy-pasting:

- `#dvStatus` — branch, commit, sync state, and working-tree changes.
- `#dvDiff` — unified diff of the working tree (optionally scoped to paths).
- `#dvLog` — recent commits with messages, authors, dates, and branch refs.
- `#dvBranches` — all branches with their tip commit IDs.

**Not implemented yet**
- Selective sync editor (`dv preferences sync_paths_rules`).
- Workspace switcher (multiple workspaces of the same repo).
- Tag UI (list / create / checkout) — tags exist in dv but aren't surfaced.
- Multi-lane DAG layout in the graph (currently linear-with-merge-markers).
- There is **no** Push or Pull — Diversion auto-syncs commits. This is by
  design, not an oversight.

## Building

```bash
npm install
npm run build       # one-shot bundle
npm run watch       # esbuild watch mode
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest unit tests (parsers + CLI runner)
npm run package     # produce a .vsix via vsce
```

Press **F5** in VS Code to launch the Extension Development Host. The `Run Extension on SampleRepo` launch configuration opens an example workspace at `~/Diversion/SampleRepo` if you have one.

### Testing in a real workspace

```bash
# Sanity-check daemon detection from the command line:
node scripts/smoke-detect.mjs ~/Diversion/MyRepo
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `diversion.path` | `""` | Path to the `dv` binary. Empty uses the system `PATH` lookup. |
| `diversion.daemonUrl` | `""` | Override the daemon URL (e.g. `http://127.0.0.1:38825`). Empty discovers from `~/.diversion/.port`. |
| `diversion.refresh.debounceMs` | `150` | Debounce window (ms) for filesystem-watcher-driven SCM refresh. Editor-originated events (save/create/delete/rename) bypass this and refresh immediately. |
| `diversion.maxParallelProcesses` | `4` | Cap on concurrent `dv` CLI processes (1–32). Higher = faster bulk operations, more CPU and daemon load. |
| `diversion.binaryExtensions` | `[]` | Extra file extensions (with leading dot, e.g. `".uplugin"`) to treat as binary — they skip side-by-side diff and open directly. |
| `diversion.scm.showAllRepoChanges` | `false` | When opening a sub-directory of a repo, the SCM panel scopes changes to that folder by default. Enable to see *all* changes in the repo. |
| `diversion.repositoryScanMaxDepth` | `1` | How many directory levels below each workspace folder to scan for nested `.diversion` repos. `0` disables nested scanning. Mirrors `git.repositoryScanMaxDepth`. |
| `diversion.log.level` | `"info"` | Output channel verbosity (`off`/`error`/`warn`/`info`/`debug`). |

## Architecture

The extension is a thin wrapper over the `dv` CLI plus the local daemon's
HTTP surface (`/health`, `/workspaces`). The daemon supplies workspace
identity (path → branch / commit / paused state); the CLI supplies
everything else. Output parsing lives in [`src/diversion/parsers/`](src/diversion/parsers/) with
fixture-backed unit tests in [`test/unit/parsers/`](test/unit/parsers/).

For the design rationale, mapping of VS Code SCM concepts to `dv` commands,
risks (CLI output drift, QuickDiff fragility), and the v0.2+ roadmap, see
[`docs/PLAN.md`](docs/PLAN.md).

## Hard rules baked into the UX

- Never invent CLI flags. Every flag is verified against `dv help <cmd>`.
- Never assume git semantics. No push, no pull, no inline merge-conflict markers.
- Always parse `dv` output through small, fixture-backed parsers — never a single mega-regex.

## License

[The Unlicense](https://unlicense.org) — public domain dedication. See [LICENSE](LICENSE).
