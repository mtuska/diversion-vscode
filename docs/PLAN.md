# Diversion VS Code Extension — Phase 1 Plan

Status: **draft for review**. Do not start scaffolding until this plan is approved.

Probed against `dv v0.9.895` and a real workspace at `/path/to/SampleRepo` on 2026-05-09.

---

## 1. Headline findings from Phase 1 research

These shaped the plan and are worth the user reading before approving.

### 1.1 There is a local Diversion daemon with a small HTTP API

`dv` is not a one-shot CLI — it talks to a long-running daemon (`agent`) running on `127.0.0.1`. The port is published in `~/.diversion/.port`, and the daemon exposes a tiny JSON HTTP surface:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{"Version": "v0.9.895"}` |
| `GET` | `/workspaces` | Map of `WorkspaceID → { Path, RepoID, BranchID, BranchName, CommitID, Paused, ShouldDownload, RepoName, ReadOnly, DigestMethod, OrganizationTier }` |

Tried and **404**: `/repos`, `/branches`, `/commits`, `/locks`, `/shelves`, `/conflicts`, `/preferences`, `/workspaces/<id>`, `/workspaces/<id>/status`. So the daemon is great for discovery and won't help with state queries — CLI parsing is unavoidable for everything else.

We will use the daemon API for: workspace detection (path → workspace lookup), branch name on the status bar, paused/sync state, and repo identity. Anything else goes through `dv`.

The same JSON registry is mirrored at `~/.diversion/config.json` (read-only fallback if the daemon is down).

### 1.2 Activation marker is `.diversion/` in the workspace root

Every cloned/initialized Diversion repo has a `.diversion/` directory at its root containing the workspace ID file (e.g. `dv.ws.<uuid>`) and an object cache. This is the right activation trigger — both as `workspaceContains:.diversion` in `package.json` and as the directory walk during `activate()`.

We **cross-check** against the daemon's `/workspaces` registry to confirm the path is actually known to Diversion (a stray `.diversion` directory left behind from `dv unregister` would otherwise fool us).

### 1.3 No `--json` / `--porcelain` flags exist in `dv v0.9.895`

I checked `dv help <command>` for every command we need (status, commit, log, diff, branch, checkout, merge, shelf, reset, revert, restore, lock, workspace, preferences). **None has a machine-readable output mode.** Parsing human-formatted stdout is unavoidable for state queries.

This is the single largest project risk and shapes the architecture below: the parser layer is isolated, fixture-tested, and swappable for when machine output ships.

### 1.4 `dv` returns exit code 0 for "not in a repo"

```
$ cd /tmp && dv status; echo $?
Current directory is not a diversion repository (neither is any of its parent directories).
0
```

Several dv commands print errors to stdout with exit 0. The CLI runner has to inspect output — not just exit code — to detect failures. We will normalize this in `cli.ts`.

### 1.5 `dv diff --name-status` is the cleanest state source

`dv status` is human-formatted with section headers (`New:`, `Modified:`, `Deleted:`) and tab-indented paths. `dv diff --name-status` is one line per change: `<A|M|D|R>\t<path>`. We use `--name-status` as the primary source for the Changes group; we still need `dv status` for sync state and the "(N files)" hint, but it's secondary.

### 1.6 No `dv cat` / `dv show <commit>:<path>` — QuickDiff is non-trivial

VS Code's `QuickDiffProvider` needs the *base* contents of a file as a `Uri`. Diversion has no command to print blob contents to stdout. Options:

- **Option A — parse `dv diff <path>` and reverse-apply** in a `TextDocumentContentProvider` registered on a custom `dv:` scheme. In-memory only. Fast. Risk: parsing unified diffs correctly (binary, renames, line-ending normalization).
- **Option B — `dv restore <commit> <path>` to a temp dir** and read it back. Simpler but slow, touches the filesystem, and fights with the workspace mirror.
- **Option C — REST API `get-blob-contents`** via the cloud. Requires the user's auth token and outbound network on every diff render. Ruled out for the inner loop.

**Decision: Option A is the v0.1 plan.** Implement reverse-patch in `quickDiff.ts` against `dv diff --color=never <path>`. Fall back to Option B for binaries (where reverse-patch is meaningless anyway). Document this choice in the parser tests.

### 1.7 Two conflict surfaces, neither really CLI-driven

- **Sync conflicts**: surface as `<file>.dv-conflict.<ext>` (and `.dv-conflict-1`, etc.) sidecar files in the working tree. Detected by filesystem glob, not by CLI.
- **Merge conflicts**: held in the cloud, resolved in the desktop/web UI. The CLI offers nothing for inline resolution. Our v0.1 stance is to detect them in `dv status` output and surface a "Resolve in Web UI" command that opens `dv view`.

---

## 2. Mapping: VS Code SCM concept → `dv` (or daemon) backing

| VS Code concept | Backing | Notes |
|---|---|---|
| Activation | `.diversion/` directory + `GET /workspaces` cross-check | Belt-and-suspenders. Daemon is authoritative when up. |
| `SourceControl` ("Diversion") | n/a (registration only) | One per detected workspace. |
| `SourceControl.label` | Daemon `RepoName` | e.g. "Diversion · SampleRepo" |
| `SourceControl.rootUri` | Daemon `Path` | |
| `SourceControl.statusBarCommands` | Daemon `BranchName`, `Paused` | Branch name + sync state. Click → quick-pick. |
| Resource group "Changes" | `dv diff --name-status` (M/D/R rows) + cross-ref to `dv status` for new files | Primary state source. |
| Resource group "Untracked" | `dv diff --name-status` (A rows) | Diversion auto-tracks, so "new" ≈ "untracked". |
| Resource group "Conflicts" *(stretch)* | Filesystem glob for `*.dv-conflict.*`; also detect merge state via `dv status` | v0.2. |
| `SourceControlResourceState.command` | Open native VS Code diff against base | Wired to `vscode.diff` with our `dv:` content provider. |
| `SourceControlResourceState.decorations` | Letter (M/A/D/R) + color | Standard SCM convention. |
| `SourceControl.inputBox` value → commit | `dv commit -a -m "<msg>"` (or `dv commit <paths> -m "<msg>"` for partial) | We support partial commits when fewer than all resources are checked. |
| `QuickDiffProvider.provideOriginalResource` | Custom `dv:` Uri scheme + `TextDocumentContentProvider` that reverse-patches `dv diff <path>` output | See §1.6. |
| Status bar item | Daemon registry | Branch + paused indicator. Click → branch quick-pick. |
| `Diversion: Refresh` | `dv status` + `dv diff --name-status` | Re-pull state. |
| `Diversion: Discard Changes` | `dv reset <path>` | |
| `Diversion: Discard All` | `dv reset --all -f` | Confirm dialog. `--clean` left out of v0.1; offered as a follow-up "Discard All Including New". |
| `Diversion: View History` | `dv log -n 50 --oneline` then `dv log <id>` for detail | Render in webview. |
| `Diversion: Open in Web UI` | `dv view` | Spawns and forgets. |
| `Diversion: Switch Branch` (status bar) | `dv branch` (list) → `dv checkout <ref>` | Prompt for change-handling: take / shelve / discard. |
| `Diversion: Create Branch` | `dv branch -c <name>` | |
| `Diversion: Merge Into Current` | `dv merge-preview <ref>` then `dv merge <ref>` | Preview first; bail if conflicts detected. |

What we explicitly do **not** map (v0.1 — by design, see "Hard rules" in the brief):

- "Push" / "Pull" buttons. Diversion auto-syncs.
- Inline merge-conflict resolution.
- Stash terminology. We say "Shelf".

---

## 3. File layout

Aligned with the architecture sketch in the brief, with small adjustments based on what Phase 1 turned up.

```
diversion-vscode/
├── package.json                      # extension manifest, vsce-ready
├── tsconfig.json                     # strict mode
├── esbuild.config.mjs                # bundle config
├── .vscodeignore
├── README.md
├── docs/
│   └── PLAN.md                       # this file
├── src/
│   ├── extension.ts                  # activate(), command/provider wiring, lifecycle
│   ├── diversion/
│   │   ├── daemon.ts                 # HTTP client for ~/.diversion/.port: /health, /workspaces
│   │   ├── cli.ts                    # spawn `dv`, cancellable, output normalization, error detection (note: exit 0 ≠ success)
│   │   ├── parsers/
│   │   │   ├── status.ts             # `dv status` → { repo, branch, workspace, commit, sections }
│   │   │   ├── diffNameStatus.ts     # `dv diff --name-status` → FileChange[]
│   │   │   ├── log.ts                # `dv log` and `--oneline` parsers
│   │   │   ├── branch.ts             # `dv branch` (list) → Branch[]
│   │   │   ├── lock.ts               # `dv lock` (list) → Lock[]   (Phase 3)
│   │   │   ├── shelf.ts              # `dv shelf` (list)            (Phase 3)
│   │   │   └── unifiedDiff.ts        # parse + reverse-apply for QuickDiff
│   │   ├── repo.ts                   # high-level facade: getStatus, commit, switchBranch, ...
│   │   └── types.ts                  # Repo, Branch, Workspace, FileChange, ChangeKind, Lock, Shelf
│   ├── scm/
│   │   ├── provider.ts               # SourceControl + resource groups, refresh logic
│   │   ├── quickDiff.ts              # QuickDiffProvider + dv: scheme TextDocumentContentProvider
│   │   └── decorations.ts            # FileDecorationProvider (explorer badges, lock indicators in Phase 3)
│   ├── ui/
│   │   ├── statusBar.ts              # branch + paused/synced indicator
│   │   ├── commands.ts               # palette/menu commands → repo facade
│   │   └── webviews/
│   │       └── log.ts                # commit log webview
│   └── util/
│       ├── fsWatch.ts                # debounced file-watcher → schedule refresh
│       ├── log.ts                    # output channel logger
│       └── disposables.ts            # tiny Disposable registry helper
├── test/
│   ├── unit/
│   │   ├── parsers/
│   │   │   ├── status.test.ts
│   │   │   ├── diffNameStatus.test.ts
│   │   │   ├── log.test.ts
│   │   │   ├── branch.test.ts
│   │   │   └── unifiedDiff.test.ts
│   │   ├── daemon.test.ts            # mock HTTP
│   │   └── cli.test.ts               # mock spawn
│   ├── e2e/
│   │   └── smoke.test.ts             # @vscode/test-electron, one happy-path scenario
│   └── fixtures/
│       ├── status-clean.txt
│       ├── status-modified-and-new.txt
│       ├── status-conflict.txt       # captured later
│       ├── diff-name-status.txt
│       ├── log-oneline.txt
│       ├── log-full.txt
│       ├── branch-list.txt
│       ├── lock-list.txt             # Phase 3
│       └── shelf-list.txt            # Phase 3
└── .vscode/
    ├── launch.json                   # run Extension Development Host
    └── tasks.json                    # esbuild --watch task
```

### Real fixtures captured today (will live in `test/fixtures/`)

```
# status-modified-and-new.txt
In repo SampleRepo dv.repo.00000000-0000-0000-0000-000000000000
On branch main dv.branch.1
Cloud workspace is over commit dv.commit.40
Working in workspace sample-workspace @ sample-host (dv.ws.00000000-0000-0000-0000-000000000000)
Total modified paths: 1 (0 files)
New:
	 Plugins/UnrealClaude

# diff-name-status.txt
A	Plugins/UnrealClaude

# log-oneline.txt
dv.commit.40 TEST2
dv.commit.38 TEST
dv.commit.37 Updated perception to stagger updates for the character so it doesn't...

# log-full.txt
commit dv.commit.40 (dv.branch.1)
Author: A. Sample <author@example.com>
Date:   04-11-2026 15:42:03

	TEST2

commit dv.commit.38 (dv.branch.1)
Merge:  ai-tuska dv.branch.5
Author: A. Sample <author@example.com>
Date:   04-11-2026 15:39:05

	TEST

# branch-list.txt
(blank line)
branch main (dv.branch.1)
commit dv.commit.40

branch ai-tuska (dv.branch.5)
commit dv.commit.36

branch WebUiMaybe (dv.branch.9)
commit dv.commit.34
```

Note: `dv log` uses `MM-DD-YYYY HH:MM:SS` (US style), not ISO. `--date iso` flag exists per `dv help log` and we will pass it.

---

## 4. MVP feature list (v0.1)

Repeats the brief's "Definition of done" with our cuts and additions made explicit.

**In scope for v0.1**

1. Activation in Diversion repos only (no-op elsewhere). Activation events: `workspaceContains:.diversion`, `onStartupFinished` (cheap path-walk fallback).
2. `Diversion` SourceControl provider with two groups: **Changes** (M/D/R) and **New** (A).
3. State refresh on:
   - file save (debounced 250ms),
   - file create/delete (debounced 500ms),
   - explicit `Diversion: Refresh` command,
   - daemon `/workspaces` poll on focus change (cheap, detects branch switches done outside VS Code).
4. Commit input box → `dv commit -a -m "<msg>"` (all checked) or `dv commit <paths> -m "<msg>"` (partial).
5. Inline diff against base via `QuickDiffProvider` (Option A: reverse-apply unified diff).
6. Status bar: `<branch> · <paused?>`. Click opens quick-pick: Switch / Create / Merge.
7. Commands: Refresh, Commit, Discard Changes, Discard All (with confirm), View History, Open in Web UI, Switch Branch, Create Branch, Merge Into Current.
8. Output channel `Diversion` for CLI traces (level controlled by setting).
9. README with install, command list, scope, known limitations.
10. `vsce package` produces a clean `.vsix`.

**Explicitly deferred to v0.2+**

- Hard locks UI (Phase 3 task in the brief).
- Shelves UI (Phase 3).
- Sync-conflict ("Conflicts" group + resolution helper).
- Selective sync editor.
- Workspace switcher.
- Cherry-pick / revert / revert-to-commit / restore commands.
- Tags.

---

## 5. Risks and open questions

Ranked by impact.

1. **CLI output drift across `dv` versions.** No machine output mode; we lock onto v0.9.895 today. *Mitigation*: every parser is fixture-backed, isolated, and called through one `repo.ts` facade; we record the observed dv version on activation and warn if it deviates wildly. *Open question*: should we hard-pin a tested `dv` version range in `package.json` and refuse to activate outside it?
2. **QuickDiff via reverse-apply is fragile** for binaries, renames, and unusual line endings. *Mitigation*: fall back to "no diff available" gracefully; never crash the SCM panel. Binary diff is acceptable to skip in v0.1.
3. **Daemon may be down or on a different port** if the user runs multiple `dv` versions side-by-side. *Mitigation*: detect, surface a clear status bar warning ("Diversion daemon offline — start with `dv status`"), and degrade gracefully — most commands still work via CLI.
4. **`dv status` exits 0 on errors.** *Mitigation*: explicit error-string detection in `cli.ts`; the parser layer never sees error output.
5. **Large repos: `dv status` can be slow** (the brief mentions this). *Mitigation*: progress notifications for slow operations; cancel-and-restart semantics on the refresh queue (latest request wins).
6. **Sync conflicts need filesystem watching** for `*.dv-conflict.*` patterns. v0.1 doesn't implement the Conflicts group, but `fsWatch.ts` should be designed so adding it later is a small change.
7. **`dv commit` with hooks blocks for arbitrary time.** *Mitigation*: long-running progress, cancel button calls process.kill(). Note the user may need to clean up partial state if killed mid-hook.
8. **VS Code SCM API decoration types** — the docs page is light on field-level detail and the `vscode.d.ts` fetch was too long for WebFetch. *Mitigation*: pull `vscode.d.ts` locally during scaffold (it ships with `@types/vscode`) and read it before writing `provider.ts`. No design decision blocked here, just noted.

**Open questions for the user before scaffolding starts:**

- **Q1**: Should we ship as a *replacement* for git's SCM panel when both are present, or *coexist*? VS Code allows multiple SourceControl instances — coexistence is the safer default but can confuse users if a git directory and a Diversion workspace overlap. Recommend coexist + a warning when overlap is detected.
- **Q2**: VS Code minimum version. Brief says "1.80+". Is that a hard floor or a starting point? The decoration API surfaces we use are stable since 1.50; 1.80 gives us comfortable headroom.
- **Q3**: Settings — do we want a `diversion.path` setting to override the `dv` binary location, and a `diversion.daemonUrl` to override port discovery? Recommend both, default to the standard locations.
- **Q4**: Telemetry — none in v0.1, correct?

---

## 6. Implementation order (post-approval)

Each step is a verifiable slice — run in the Extension Development Host against the real `SampleRepo` workspace at the end of each.

1. **Scaffold**: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `.vscode/launch.json`, hello-world `extension.ts`. Verify: F5 launches host, command palette shows "Diversion: Hello".
2. **Daemon client + repo detection**: `daemon.ts`, walk `.diversion/`, cross-check workspace path. Verify: extension activates only in `SampleRepo`, not in `/tmp`.
3. **CLI runner + `dv status` + `dv diff --name-status` parsers** with fixtures. Verify: unit tests pass on captured fixtures.
4. **SCM provider with Changes + New groups**. Verify: open `SampleRepo`, see `Plugins/UnrealClaude` in New.
5. **Commit flow**. Verify: commit a no-op change end-to-end (test on a throwaway branch).
6. **QuickDiff (Option A)**. Verify: gutter diff appears for a modified text file.
7. **Status bar + branch quick-pick**. Verify: switch branch from VS Code, see status bar and SCM groups update.
8. **Discard / Refresh / View History / Open in Web UI**. Verify: each end-to-end.
9. **Polish: settings, errors, output channel, README**. Verify: `vsce package` produces a clean `.vsix`; install in fresh VS Code; smoke-test.

After each slice, the criteria is: works in the real workspace, parsers pass fixture tests, no exceptions in the host's developer console.

---

## 7. Stretch (v0.2+) — order of attack

1. Sync-conflict detection (`*.dv-conflict.*` glob → Conflicts group + "Open Diff" + "Mark Resolved" commands).
2. Hard locks (`dv lock` parser, FileDecorationProvider for explorer badges, lock/unlock context-menu commands).
3. Shelves tree view (`dv shelf` parser, create/apply/delete commands).
4. Selective sync UI (read/edit `dv preferences sync_paths_rules`).
5. Workspace switcher (multiple workspaces from `/workspaces`).
6. Merge conflict surface (`dv status` parsing for in-flight merge → "Resolve in Web UI" prominent action).

---

## 8. Pause point

This is the end of Phase 1. **Awaiting review** before scaffolding. Feedback wanted on §1.6 (QuickDiff approach), §5 open questions, and the v0.1/v0.2 split.
