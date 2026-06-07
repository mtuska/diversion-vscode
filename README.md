# Diversion for VS Code

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/mtuska.diversion-vscode?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/mtuska.diversion-vscode)](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode)
[![Latest release](https://img.shields.io/github/v/release/mtuska/diversion-vscode?include_prereleases&sort=semver)](https://github.com/mtuska/diversion-vscode/releases/latest)
[![Release workflow](https://github.com/mtuska/diversion-vscode/actions/workflows/release.yml/badge.svg)](https://github.com/mtuska/diversion-vscode/actions/workflows/release.yml)
[![CI](https://github.com/mtuska/diversion-vscode/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/mtuska/diversion-vscode/actions/workflows/ci.yml)

Source-control integration for [Diversion](https://www.diversion.dev) — registers Diversion as a first-class SCM provider in VS Code, and ships a standalone stdio MCP server (`diversion-mcp`) so any MCP-aware AI client can drive your Diversion workspaces.

> **Status: v0.6.x.** Available on the [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode). Tested against `dv v1.0.x` on VS Code 1.95+ and on Linux / macOS / Windows. Coexists peacefully with the built-in Git provider; activates whenever the open folder lives inside (or is) a Diversion-managed workspace.

This v0.6 release **cuts read operations over to the Diversion CoreAPI**. Status, changed files, branches, log/history, per-commit diffs, shelves, and the repo list are now sourced from structured cloud endpoints (`https://api.diversion.dev/v0`) instead of text-parsing the `dv` CLI — authenticated by a short-lived token minted by the local sync agent, so there's no extra OAuth to configure. Only the operations with no API equivalent (**file locks** and **line-level blame**) still parse CLI output, and write operations (commit, checkout, merge, …) still go through `dv`. The extension and the **MCP server** share this CoreAPI client and the same dv-CLI runner.

## What you get

- **VS Code SCM provider** — branches, commits, diffs, shelves, locks, blame, the Source Control Graph. Plus all the read & write operations exposed to **GitHub Copilot Chat** (or any client of the VS Code Language Model API) as referenceable tools — `#dvStatus`, `#dvDiff`, `#dvCommit`, `#dvOverlap`, etc.
- **`diversion-mcp` standalone stdio server**, published to npm as [`@mtuska/diversion-mcp`](https://www.npmjs.com/package/@mtuska/diversion-mcp), exposing the same operations over the Model Context Protocol plus a couple of MCP-only helpers (`dv_list_repos`, `dv_open_in_web`). One-liner setup with `npx -y @mtuska/diversion-mcp` from **Claude Code**, **Codex**, **Claude Desktop**, **Cursor**, **Windsurf**, or anything that speaks MCP.

See the [Language Model Tools](#language-model-tools) section for the full tool list — every Diversion operation the extension performs internally is also a tool both the in-VS-Code and out-of-VS-Code AI clients can call.

## Requirements

- The `dv` CLI on your `PATH` (or set `diversion.path`). The extension
  defaults to `dv` on macOS / Linux and `dv.exe` on Windows.
- A workspace cloned with `dv clone` or initialized with `dv init`. The
  extension activates whenever the open folder is inside a Diversion repo
  — opening a sub-directory of a `.diversion/`-marked tree works too; we
  walk up to find the actual repo root.
- The Diversion daemon running locally (it is when `dv status` works).
- VS Code 1.95 or newer.
- Node 18+ if you intend to run the standalone MCP server outside VS Code.

## Installing the VS Code extension

### Option 1: VS Marketplace (recommended)

Install directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mtuska.diversion-vscode), or from the command line:

```bash
code --install-extension mtuska.diversion-vscode
```

You can also search for **Diversion** in the VS Code Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).

### Option 2: install the latest `.vsix` from a release

Download the `.vsix` from the [Releases page](https://github.com/mtuska/diversion-vscode/releases), then:

```bash
code --install-extension diversion-vscode-<version>.vsix
```

### Option 3: build from source

```bash
git clone https://github.com/mtuska/diversion-vscode.git
cd diversion-vscode
npm install
npm run package          # produces diversion-vscode-<version>.vsix + out/mcp.js
code --install-extension diversion-vscode-*.vsix
```

### Option 4: run unpacked from source (development)

```bash
git clone https://github.com/mtuska/diversion-vscode.git
cd diversion-vscode
npm install
npm run build            # or `npm run watch` for incremental rebuilds
```

Open the project folder in VS Code and press **F5**. A second VS Code window opens with the extension loaded ("Extension Development Host"). Proposed APIs (the SCM Graph) are auto-enabled in this mode.

### Verifying

After installing, open a Diversion-managed folder. You should see:

- A **Diversion** entry in the **Source Control** view, with a branch pill next to the repo name and a `…` menu.
- The current branch in the bottom-left status bar.
- Output channel **Diversion** (View → Output → choose "Diversion") with an activation log line.

If nothing happens, run `Diversion: Show Daemon Health` from the command palette — that's the first sanity check.

## Installing the MCP server

The MCP server is published to npm as [`@mtuska/diversion-mcp`](https://www.npmjs.com/package/@mtuska/diversion-mcp). Most clients can invoke it directly via `npx` with zero preinstall — every release on the [Releases page](https://github.com/mtuska/diversion-vscode/releases) ships the same binary, kept lockstep with the VS Code extension. Node 18+ on Linux / macOS / Windows.

### Register with Claude Code

```bash
# This-machine-only (default)
claude mcp add diversion -- npx -y @mtuska/diversion-mcp

# Per-project (commits a .mcp.json into the repo)
claude mcp add --scope project diversion -- npx -y @mtuska/diversion-mcp

# Cross-project (~/.claude.json)
claude mcp add --scope user diversion -- npx -y @mtuska/diversion-mcp
```

Inside Claude Code, `/mcp` confirms the connection and the tool list.

### Register with Codex (OpenAI CLI)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.diversion]
command = "npx"
args = ["-y", "@mtuska/diversion-mcp"]
```

### Register with Claude Desktop, Cursor, Windsurf, etc.

```json
{
  "mcpServers": {
    "diversion": {
      "command": "npx",
      "args": ["-y", "@mtuska/diversion-mcp"]
    }
  }
}
```

The `-y` flag silently accepts npx's "install on first run" prompt — without it some MCP clients hang waiting on a TTY they never provide.

### Alternatives without npm

If `npx` isn't an option (offline machine, locked-down corporate network, you'd rather pin to a specific download):

```bash
# Option A — install globally from npm
npm install -g @mtuska/diversion-mcp
# then in your MCP config:    command = "diversion-mcp"

# Option B — grab the standalone bundle from the GitHub release
curl -L -o diversion-mcp.js \
  https://github.com/mtuska/diversion-vscode/releases/latest/download/diversion-mcp.js
chmod +x diversion-mcp.js
# then:    command = "node"; args = ["/absolute/path/to/diversion-mcp.js"]

# Option C — from a source checkout
git clone https://github.com/mtuska/diversion-vscode.git
cd diversion-vscode
npm install
npm run build
sudo npm link
# then:    command = "diversion-mcp"
```

`npm install -g` and `npm link` both create a `diversion-mcp.cmd` shim on Windows automatically — no extra steps needed there.

### Verifying

Standalone handshake — should print a JSON `protocolVersion` line on stdout:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | npx -y @mtuska/diversion-mcp
```

### No env config required

Diversion has a centralised local agent that already knows every workspace on the machine. The MCP server pulls workspaces from the agent's registry at startup — you don't have to declare paths, point at config files, or symlink anything. If the agent is offline, the server falls back to the current working directory; if the model passes a `repo` hint to any tool, the server registers that path on the fly.

Optional escape-hatch env vars:

| Var | Default | Purpose |
|---|---|---|
| `DIVERSION_DV_PATH` | `dv` on `$PATH` | Override the `dv` binary location |
| `DIVERSION_DAEMON_URL` | (port-file discovery) | Override agent URL, e.g. `http://127.0.0.1:38825` |
| `DIVERSION_MAX_PARALLEL` | `4` | Concurrent `dv` processes cap |
| `DIVERSION_LOG_LEVEL` | `info` | `off` / `error` / `warn` / `info` / `debug` (logged to stderr) |

## Platform support

| Platform | dv binary | VS Code extension | `diversion-mcp` |
|---|---|---|---|
| Linux   | `dv`     | Tested. Active development platform. | Tested. |
| macOS   | `dv`     | Should work; same `dv` semantics as Linux. Untested. | Should work; same code path as Linux. |
| Windows | `dv.exe` | Should work; path handling is sep- and case-aware. Untested with a real Windows dv install. | `npx @mtuska/diversion-mcp` works in cmd / PowerShell / Git Bash. The bundle is plain Node CJS with a shebang; npm-install-g and npm-link auto-generate a `diversion-mcp.cmd` shim for direct invocations. The `dv` binary is auto-resolved as `dv.exe`. |

If you hit a platform-specific issue, file it with the contents of the `Diversion` output channel and we'll triage. The `Diversion: Run Performance Trace` command's output is also useful — it tells us whether the daemon and `dv` itself are responding the way we expect.

## VS Code extension features

**Source Control panel**
- One **Diversion** provider per repo, keyed by the actual `.diversion/` ancestor — opening a sub-directory still registers correctly.
- Resource groups: **Conflicts**, **Staged Changes**, **Changes**, **New**. Conflicts (`*.dv-conflict.*` sidecars) surface automatically.
- Inline +/− buttons on every resource (stage / unstage), plus context-menu Stage / Unstage / Commit Selected / Discard. Multi-select works.
- Staging is persisted per-workspace via `workspaceState`, so it survives reloads.
- Commit picks the staged paths if any are staged, otherwise commits all (`dv commit <paths> -m` / `dv commit -a -m`).
- **Generate Commit Message** (sparkle button on the SCM input box) hands the current diff to your configured VS Code language model and drops the result into the commit message box.
- QuickDiff (gutter + side-by-side) via reverse-applied unified diff. Binary files skip the diff path and open directly.

**Repo header (per-repo `…` menu)**
- Branch pill (`$(git-branch) <name>`) — click to switch branches.
- Ellipsis button next to it opens a categorised quick-pick: Actions / Branch / Sync / Locks / View. Right-click on the repo row gets you the same menu.
- Sync verbs (no push/pull — Diversion auto-syncs commits): Update Workspace, Pause Sync, Resume Sync, Verify Repository.

**History**
- VS Code's built-in **Source Control Graph** populates with branches, commit timestamps, parents, and per-commit file lists. Clicking a file opens a real side-by-side diff for that commit (via a `dv-commit:` content scheme).
- **View History** webview as a textual fallback.
- **Cherry-pick / Revert / Restore-to-commit** commands.

**Game-dev specific**
- **Hard locks** (`dv lock`): 🔒 explorer badges via FileDecorationProvider, Lock / Unlock / List Locks commands. *Server-side gated to Studio / Enterprise tiers.*
- **Sync conflict resolution** for `*.dv-conflict.*` sidecars (a Diversion concept distinct from merge conflicts).
- **Shelves** tree view (`dv shelf`): create / apply / delete / rename plus Shelve-and-switch-branch.
- **Inline blame** (`dv annotate`) — `Diversion: Toggle Blame`. Block-grouped GitLens-style.

**Performance**
- Batched per-commit prefetch when the SCM Graph expands a commit (one `dv diff --base <commit>` call instead of N).
- Persistent on-disk cache for commit content (50 MB, mtime LRU, segmented by dv version) — re-opening the same commit's diffs is ~1 ms after the first session.
- `Diversion: Run Performance Trace` runs a known battery and writes per-step timings to the output channel, useful for triage.
- `diversion.maxParallelProcesses` caps concurrent `dv` invocations (default 4). Bump it on fast machines to speed up SCM Graph prefetch.

## Language Model Tools

Every Diversion operation in the extension is also exposed to AI models through two paths:

- **Inside VS Code** — 37 tools registered via `vscode.lm.registerTool`. Copilot Chat (and any provider that uses VS Code's language-model API) can invoke them, and the `#dvStatus`-style chat references work for the read-side tools.
- **Outside VS Code** — 39 tools through the `diversion-mcp` stdio MCP server. The 2 extras over the VS Code side are `dv_list_repos` (inspect the MCP server's own registry) and `dv_open_in_web` (launch `dv view` from a headless client).

The tools are otherwise identical; both share the same `Repo` facade, the same parsers, and the same dv-CLI runner under the hood. The table below lists tools by their MCP names with the `#dv…` reference name shown for the in-VS-Code equivalent.

### Awareness tools (read-only)

| Tool | What it does |
|---|---|
| `dv_status` / `#dvStatus` | Branch, commit, sync state, working-tree changes |
| `dv_diff` / `#dvDiff` | Working-tree unified diff, optionally scoped to paths |
| `dv_diff_refs` / `#dvDiffRefs` | Diff between two refs (commit / branch / tag) |
| `dv_log` / `#dvLog` | Recent commits with `since` / `until` date filters |
| `dv_file_history` / `#dvFileHistory` | `git log -- <path>` equivalent for a single file or directory |
| `dv_overlapping_commits` / `#dvOverlap` | Recent commits that touch the same paths you have dirty — "what might conflict with my work" |
| `dv_show` / `#dvShow` | Full details for a single commit, including its file list |
| `dv_branches` / `#dvBranches` | Branch list with tip commits |
| `dv_list_tags` / `#dvListTags` | All tags (backed by `dv tag --json` for stable output) |
| `dv_list_cloud_repos` / `#dvListCloudRepos` | Repos the dv account has access to (cloned vs remote-only) |
| `dv_list_repos` *(MCP only)* | Repos this MCP server has registered — inspect the registry. In VS Code the SCM panel already shows the same info |
| `dv_shelves` / `#dvShelves` | List shelves |
| `dv_show_shelf` / `#dvShowShelf` | Inspect a single shelf's contents |
| `dv_locks` / `#dvLocks` | Active hard locks |
| `dv_annotate` / `#dvAnnotate` | Per-line blame for a file |

### Action tools (write)

| Tool | What it does |
|---|---|
| `dv_commit` / `#dvCommit` | Commit working-tree changes, optionally scoped to paths |
| `dv_create_branch` / `#dvCreateBranch` | Create a branch (optionally switch to it) |
| `dv_delete_branch` / `#dvDeleteBranch` | Delete a branch |
| `dv_rename_branch` / `#dvRenameBranch` | Rename a branch |
| `dv_checkout` / `#dvCheckout` | Check out a ref with take/shelve/discard semantics |
| `dv_merge` / `#dvMerge` | Merge a ref into the current branch |
| `dv_cherry_pick` / `#dvCherryPick` | Cherry-pick a single commit |
| `dv_revert_commit` / `#dvRevertCommit` | Create a new commit that inverts a past commit |
| `dv_revert_to_commit` / `#dvRevertToCommit` | Restore the workspace to a past commit |
| `dv_restore_path` / `#dvRestorePath` | Restore one path from a ref |
| `dv_discard_path` / `#dvDiscardPath` | Discard changes to a single path |
| `dv_discard_all` / `#dvDiscardAll` | Discard all working-tree changes (optionally including new files) |
| `dv_create_tag` / `#dvCreateTag` | Tag a commit |
| `dv_create_shelf` / `#dvCreateShelf` | Shelve current changes |
| `dv_apply_shelf` / `#dvApplyShelf` | Apply a shelved changeset |
| `dv_delete_shelf` / `#dvDeleteShelf` | Delete a shelf |
| `dv_rename_shelf` / `#dvRenameShelf` | Rename a shelf |
| `dv_lock_path` / `#dvLockPath` | Acquire a hard lock (Studio / Enterprise) |
| `dv_unlock_path` / `#dvUnlockPath` | Release a hard lock |
| `dv_pause_sync` / `#dvPauseSync` | Pause background sync |
| `dv_resume_sync` / `#dvResumeSync` | Resume background sync |
| `dv_update_workspace` / `#dvUpdateWorkspace` | Force-pull base-branch updates |
| `dv_verify` / `#dvVerify` | Run dv's integrity verification |
| `dv_open_in_web` *(MCP only)* | Open the workspace in the Diversion web UI (`dv view`). The VS Code extension already has a `Diversion: Open in Web UI` palette command for this |

In multi-repo workspaces every tool accepts an optional `repo` argument (repo name or absolute path). With a single repo open it can be omitted.

## Not implemented yet

- Selective sync editor (`dv preferences sync_paths_rules`).
- Workspace switcher (multiple workspaces of the same repo).
- Tag UI in the VS Code panel (list / create / checkout). MCP / Copilot Chat already covers it.
- Review status — Diversion's review/PR system lives in the cloud and isn't exposed via `dv` or the local agent; we don't call `api.diversion.dev` directly.
- Multi-lane DAG layout in the graph (currently linear-with-merge-markers).
- There is **no** Push or Pull — Diversion auto-syncs commits. This is by design, not an oversight.

## Building

```bash
npm install
npm run build       # one-shot bundle of extension + MCP server
npm run watch       # esbuild watch mode for both
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest unit tests (parsers + CLI runner)
npm run package     # produce a .vsix via vsce — includes out/mcp.js
```

Press **F5** in VS Code to launch the Extension Development Host. The `Run Extension on SampleRepo` launch configuration opens an example workspace at `~/Diversion/SampleRepo` if you have one.

### Testing the MCP server in a real workspace

```bash
# end-to-end roundtrip
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
 echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
 sleep 1) | node out/mcp.js | jq -r 'select(.id==2) | .result.tools | length'
# → 39
```

### Sanity-check daemon detection

```bash
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

The MCP server doesn't read VS Code settings — it's a separate process. Use the env vars in the *Installing the MCP server* section above.

## Architecture

```
                          ┌──────────────────────────┐
                          │ src/diversion/            │
                          │   daemon.ts  (AgentAPI)   │
                          │   cli.ts     (spawn dv)   │
                          │   repo.ts    (high-level) │
                          │   parsers/   (text → typed)│
                          └────────────┬─────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
        ┌───────▼───────┐      ┌───────▼────────┐    ┌────────▼────────┐
        │ src/extension │      │ src/ai/tools.ts │    │ src/mcp/         │
        │ (VS Code SCM) │      │ (vscode.lm)     │    │ (stdio MCP)     │
        └───────────────┘      └─────────────────┘    └─────────────────┘
                                       │                      │
                                       ▼                      ▼
                                 Copilot Chat         Claude Code / Codex /
                                                      Claude Desktop / Cursor /
                                                      anything MCP-aware
```

The extension and the MCP server share **everything except their host-binding layer**: the same dv-CLI runner, the same daemon HTTP client, the same parsers, the same `Repo` facade. The split is mechanical (vscode dependency vs not), so a tool added to one trivially mirrors to the other.

For the v0.1 design rationale, mapping of VS Code SCM concepts to `dv` commands, risks (CLI output drift, QuickDiff fragility), and the v0.2+ roadmap, see [`docs/PLAN.md`](docs/PLAN.md).

## Hard rules baked into the UX

- Never invent CLI flags. Every flag is verified against `dv help <cmd>`.
- Never assume git semantics. No push, no pull, no inline merge-conflict markers.
- Always parse `dv` output through small, fixture-backed parsers — never a single mega-regex.
- Never call `api.diversion.dev` (CoreAPI). It's JWT-authenticated against Diversion's cloud and we aren't a registered client. Everything goes through the local agent (no auth) or the `dv` CLI.

## License

[The Unlicense](https://unlicense.org) — public domain dedication. See [LICENSE](LICENSE).
