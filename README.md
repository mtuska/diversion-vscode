# Diversion for VS Code

Source-control integration for [Diversion](https://www.diversion.dev) — registers Diversion as a first-class SCM provider so you can commit, branch, diff, switch, and merge from inside VS Code.

> **Status: v0.1 (early).** Tested against `dv v0.9.x`. Coexists peacefully with the built-in Git provider; activates only in folders managed by Diversion.

## Requirements

- The `dv` CLI on your `PATH` (or set `diversion.path`).
- A workspace cloned with `dv clone` or initialized with `dv init` (the extension activates on the presence of a `.diversion/` directory).
- The Diversion daemon running locally (it is when `dv status` works).
- VS Code 1.93 or newer.

### Optional: enable the Source Control Graph view

Diversion populates VS Code's built-in **Source Control Graph** view via
the `scmHistoryProvider` proposed API. To use it you need to start VS Code
with the proposed API enabled for this extension:

```bash
code --enable-proposed-api diversion.diversion-vscode
```

VS Code Insiders enables proposed APIs automatically. If the flag isn't
set the rest of the extension still works — you just won't see the graph
populate until the proposal stabilises and the flag becomes unnecessary.

## What this version does

- Detects Diversion workspaces automatically (cross-checks the `.diversion/` marker against the local daemon's workspace registry).
- Registers a **Diversion** Source Control provider per workspace folder.
- Two resource groups: **Changes** (modified / deleted / renamed) and **New** (untracked).
- Auto-refreshes on file save, create, delete (debounced).
- Commit input box → `dv commit -a -m "<msg>"`.
- Inline diff vs. base via VS Code's quick-diff — implemented by parsing `dv diff <path>` and reverse-applying it (no temp files).
- Click any modified file in the SCM panel for a side-by-side diff against the base commit.
- Status bar item showing the current branch and sync state. Click → switch branch.
- **Switch branch** quick-pick with explicit handling for uncommitted changes (take / shelve / discard).
- **Create branch** prompt (auto-checks-out).
- **Merge** quick-pick (current ← chosen branch).
- **Discard** (per-file or all) with confirmation.
- **View History** in a webview showing `dv log -n 50` rendered with VS Code theme colors.
- **Open in Web UI** (`dv view`).

## What this version does *not* do (yet)

- Hard-lock UI for binary assets (`dv lock`). Coming in v0.2.
- Shelves UI (`dv shelf`). Coming in v0.2.
- A "Conflicts" group for `.dv-conflict.<ext>` sidecar files. Coming in v0.2.
- Selective sync editor (`dv preferences`).
- Workspace switcher.
- There is **no** "Push" or "Pull" — Diversion auto-syncs commits. This is by design, not an oversight.

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
| `diversion.path` | `""` | Path to the `dv` binary. Empty uses `PATH`. |
| `diversion.daemonUrl` | `""` | Override the daemon URL. Empty discovers from `~/.diversion/.port`. |
| `diversion.refresh.debounceMs` | `300` | Debounce window (ms) for auto-refresh after file changes. |
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
