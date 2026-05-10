# Diversion CLI reference

The full list of `dv` subcommands. The most common ones (status, commit, log, diff, branch, checkout, merge, shelf, lock, reset, revert) are documented in `SKILL.md`. This file covers the rest, plus full flag listings for the common ones.

For any command, `dv help <command>` shows the in-CLI help, which is authoritative for your installed version. The web docs publish each command page as `.md`, e.g. <https://docs.diversion.dev/cmd-ref/annotate.md>.

## Repository commands

### `dv init`

Initialize a new Diversion repository in the current directory. Prompts for a repo name and creates a default branch. Generates an engine-appropriate `.dvignore` if one isn't present.

### `dv clone <repo_id> [path] [--workspace <ws_id>] [--new-workspace] [--ref <ref>]`

Clone a repo to local disk. Without `[path]`, clones into a folder named after the repo. `--ref` accepts a branch name, branch ID, commit ID, or tag ID and checks it out after cloning. `--workspace` reuses an existing workspace by ID (the `dv.ws.xxxxx` form, not the human-readable name). `--new-workspace` skips the prompt and forces creation of a new workspace.

### `dv repo <subcommand>`

Repo-level operations (rename, delete, list, settings). Run `dv repo` with no args to list, or `dv help repo` for the subcommand list. Most repo administration is easier in the web UI.

### `dv unregister`

Unregister a local repository from the Diversion daemon without deleting the cloud copy. Use this when removing a working copy from your machine.

### `dv import`

Import an existing Git repository into a Diversion repo (with full history). Run from inside the source git repo, or pass a Git URL. For Git LFS sources, see the docs page on Git LFS import.

### `dv verify`

Validate local repository integrity. Useful when something feels off and you want to confirm the local state matches the cloud.

## Workspace commands

### `dv workspace [list | rename | delete | pause | resume]`

Bare `dv workspace` lists workspaces. `rename <new-name>` renames the current workspace. `delete <ws_id>` deletes a workspace by ID (you cannot delete the current one). `pause` and `resume` control background sync — pause when on a flaky network or before a big batch of edits, resume when ready.

### `dv preferences`

Get or set workspace preferences. The most important one is **selective sync** — controlling which paths actually get downloaded to disk. Useful in big repos where you only need part of the tree (e.g., engineers don't need all the source assets).

```bash
dv preferences                              # show current prefs
dv preferences sync_paths_rules <rules>     # update selective sync
```

For rule syntax see <https://docs.diversion.dev/advanced/selective-sync.md>.

### `dv update`

Sync the workspace with the latest from its base branch. Normally this happens automatically (auto-update is on by default), but if auto-update is disabled or sync was paused, `dv update` does it manually.

### `dv cd`

Change the working directory within an interactive `dv` session. Only relevant if running the interactive CLI (`dv` with no args), not for one-shot scripted use.

## Commit & branch commands

### `dv commit [files...] [-a] -m <msg> [--no-verify]`

Already covered in SKILL.md. Notes on flags:

- `-a` commits all tracked changes; without `-a`, list paths explicitly.
- `--no-verify` skips pre-commit hooks. Use sparingly.
- Commit messages must be quoted.

### `dv branch`

Bare `dv branch` lists branches. Subforms:

```bash
dv branch -c <name> [--no-checkout]      # create (and switch unless --no-checkout)
dv branch -d <name> [-f]                 # delete (-f skips confirm)
dv branch -r <branch_id> <new_name>      # rename
```

### `dv branch-name`

Print the current branch name only. Useful for scripting.

### `dv checkout <ref> [--take-changes | --shelve-changes | --discard-changes] [--apply-shelf | --ignore-shelf]`

Switch to a branch, commit, or tag. The change-handling flags decide what happens to uncommitted work in the current workspace (default behavior is to prompt). The shelf flags decide whether shelved changes on the target should be auto-applied.

### `dv merge <other_id> [--into <branch>]`

Merge a branch or commit into the current branch. `--into` overrides the destination.

### `dv merge-preview <other_id>`

Show what `dv merge` would do without doing it. Surfaces conflicts in advance.

### `dv cherry-pick <commit_id>`

Apply the changes from one commit to the current workspace.

### `dv revert <commit_id> [--conflict_resolution <strategy>]`

Create a new commit that inverts an old one. Strategies for conflicts: `manual` (default), `keep-current`, `accept-incoming`.

### `dv revert-to-commit <commit_id>`

Set the workspace contents to match the state at a specific commit. Does not rewrite history; saves the result as workspace changes that you then commit.

### `dv reset [paths...] [--all] [--clean] [-f]`

Discard uncommitted changes. `--all` resets everything; `--clean` also removes newly-added files; `-f` skips the confirmation.

### `dv restore <ref> <path>`

Restore a single file or directory from a specific commit, branch, or tag into the workspace.

### `dv tag`

Create, list, or delete tags. Subforms:

```bash
dv tag                                   # list
dv tag -c <name> <commit_id> [-m <msg>]  # create on a commit
dv tag -d <name>                         # delete
```

## Collaboration commands

### `dv invite <email> [--access read|write|admin]`

Invite a collaborator to the current repo. Defaults to write access if not specified.

### `dv share`

Currently not implemented per docs; placeholder.

### `dv lock [path] [-d]`

Hard locks. Bare `dv lock` lists locks. `dv lock <path>` locks. `dv lock -d <path>` releases. See SKILL.md "hard locks" section for the full picture.

## File commands

### `dv ls [path] [--ref <ref>]`

List files in the workspace or at a specific ref.

### `dv mv <src> <dst>`

Move or rename a file or directory in the workspace. Use this rather than `mv` so Diversion tracks the rename properly.

### `dv rm <path>`

Delete a file from the workspace. Use this rather than `rm`.

### `dv mkdir <path>`

Create a directory in the workspace.

### `dv clean`

Remove untracked files from the workspace. Roughly analogous to `git clean -fd` (whether ignored files are also removed depends on the dv version — confirm with `dv help clean` before relying on either behavior). Destructive; confirm with the user before running.

## Inspection / utility

### `dv show <commit_id>`

Show details of a commit (message, author, changed files, diff).

### `dv annotate <path>`

Show line-by-line commit attribution for a text file. Equivalent to `git blame`.

### `dv view`

Open the current workspace in the Diversion web UI in a browser.

### `dv status [paths...] [--sync-only] [--nowait] [--commit-id-only] [--no-limit]`

Workspace status. `--sync-only` reports just the sync state (useful when you don't care about the changelist). `--nowait` returns immediately rather than waiting for sync to settle. `--commit-id-only` prints just the commit ID — handy for scripts. `--no-limit` removes the changelist truncation.

### `dv log [path] [-n <num>] [--oneline] [--since <date>] [--until <date>] [--date <format>]`

Commit history. `-n` defaults to 20, max 1000. Date filters accept ISO format or relative (`"2 weeks ago"`).

### `dv diff [paths...] [--base <ref>] [--compare <ref>] [--name-status] [--color <mode>]`

Diff. Without flags, compares the workspace to its base commit. `--name-status` gives the summary (`A`/`M`/`D`/`R` flags). `--base` and `--compare` set arbitrary refs.

### `dv help [command]`

In-CLI help. Authoritative for the installed version of `dv`.

### `dv version`

Print the installed `dv` version.

### `dv login` / `dv logout`

Authenticate. `dv login` opens a browser flow.

### `dv feedback`

Send feedback to the Diversion team.

### `dv support`

Generate a support bundle for troubleshooting (logs, repo state, config). Upload it when contacting Diversion support.

## Interactive mode

Running `dv` with no arguments opens an interactive shell with autocomplete. Inside it, you drop the `dv` prefix:

```text
> status
> commit -a -m "fix bug"
> branch -c new-feature
```

For scripted or one-shot use, prefer the non-interactive form (`dv status`, etc.).

## Where to look for what's missing

If a command isn't here, check:

1. `dv help` (in-CLI listing)
2. <https://docs.diversion.dev/llms.txt> (full doc index)
3. The specific page as `.md`, e.g. <https://docs.diversion.dev/cmd-ref/preferences.md>

The REST API has its own surface that the CLI doesn't fully expose; for things like webhooks, granular path permissions, or programmatic repo management, see <https://docs.diversion.dev/api-reference/introduction.md>.
