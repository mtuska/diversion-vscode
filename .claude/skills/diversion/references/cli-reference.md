# Diversion CLI reference

The full list of `dv` subcommands. The most common ones (status, commit, log, diff, branch, checkout, merge, shelf, lock, reset, revert) are documented in `SKILL.md`. This file covers the rest, plus full flag listings for the common ones.

For any command, `dv help <command>` shows the in-CLI help, which is authoritative for your installed version. The web docs publish each command page as `.md`, e.g. <https://docs.diversion.dev/cmd-ref/annotate.md>.

**`dv --help` does not list every command.** `verify`, `ls`, `mv`, `rm`, `mkdir`, `review`, and `version` are all real but hidden from the top-level listing. Check `dv help <command>` before concluding something doesn't exist.

**`dv` prompts on stdin and does not detect a non-TTY.** A command that would ask for confirmation blocks forever when run from a script or an agent rather than failing. Always pass the skip-flag: `reset -f`, `clean -f`, `branch -d ... -f`, `tag -d ... -f`, `shelf apply/delete -f`, and one flag from *each* group on `checkout` (`--take-changes|--shelve-changes|--discard-changes` and `--apply-shelf|--ignore-shelf`). Redirecting stdin from `/dev/null` is a usable backstop — it turns the hang into a fast failure — but the flag is what makes the command succeed.

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

### `dv checkout <ref> [--take-changes | --shelve-changes | --discard-changes] [--apply-shelf | --ignore-shelf] [--nowait]`

Switch to a branch, commit, or tag. The change-handling flags decide what happens to uncommitted work in the current workspace; the shelf flags decide whether shelved changes on the target are auto-applied. **Both default to prompting**, so a scripted checkout needs one flag from each group or it hangs — see the prompts note at the top of this file. `--nowait` returns before the local file sync finishes.

### `dv merge <other_id> [--into <branch>] [--delete-branch] [--conflict_resolution <strategy>] [-l]`

Merge a branch or commit into the current branch. `--into` overrides the destination; `--delete-branch` removes the source afterwards.

Conflict strategies: `manual` (default — parks the merge for per-block resolution in the Diversion app), `keep-destination`, `accept-incoming`. **This enum is not the same as `dv revert`/`dv update`**, which use `keep-current` where merge uses `keep-destination`.

`dv merge -l` lists open (unresolved) merges. A conflicting merge exits 0 and is parked server-side rather than failing, so `-l` is the only way to tell "merged" from "stopped on conflicts". These are *not* the `.dv-conflict` sidecar files — those are sync conflicts on disk and are a separate mechanism.

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

### `dv restore <path> [--source <ref>] [--nowait]`

Restore a single file or directory into the workspace. Note the operand order: the **path** is positional and the source ref is a flag, defaulting to the workspace's base commit.

### `dv tag [--json]`

List, create, modify, or delete tags. `--json` emits `{"object":"Tag","items":[...]}` — always prefer it over parsing the human output.

```bash
dv tag --json                                   # list
dv tag -c <name> [-a <desc>] [--ref <commit>]   # create (defaults to current commit)
dv tag -m <tag_id> [--name <new>] [-a <desc>]   # rename and/or re-describe
dv tag -d <tag_id> [-f]                         # delete
```

`-m` and `-d` take the tag **ID** (`dv.tag.<n>`), not the name — get it from `dv tag --json`. `-a` is the description; there is no `-m <msg>` for create (that spelling is `modify`).

### `dv prune <subcommand>`

Revision-retention rules — an automatic `dv obliterate` that keeps only the last N revisions of matching files. Studio/Enterprise only.

```bash
dv prune list                              # rules in priority order (last match wins)
dv prune add <pattern> --keep <1-999|all>  # appended = highest priority
dv prune set <id> [--keep <n>] [--pattern <glob>]
dv prune remove <id>
dv prune config [--case-insensitive true|false]
```

Patterns are repo-root-anchored globs (e.g. `/Assets/*.psd`). See <https://docs.diversion.dev/advanced/revision-limits>.

### `dv obliterate <subcommand>`

Permanently delete blob storage for matching file versions. Org-admin only, and irreversible — confirm with the user first.

```bash
dv obliterate preview <glob> [--json]           # dry run: counts + reclaim estimate
dv obliterate execute <glob> [--yes] [--json]   # --yes is required with --json
dv obliterate status <job_id>
```

### `dv shelf <subcommand>`

Set changes aside without committing.

```bash
dv shelf create <name> [paths...] [--no-reset]
dv shelf show <shelf>
dv shelf apply <shelf> [--keep] [-f]
dv shelf rename <shelf> <new_name>
dv shelf delete <shelf> [-f]
```

`<shelf>` accepts an ID or a name. `apply` deletes the shelf unless `--keep`.

### `dv review <title> [--into <base_ref>] [-d <description>]`

Open a review request for the current branch. Defaults to merging into the repository's default branch.

## Collaboration commands

### `dv invite <email> --access READ|WRITE|ADMIN|OWNER`

Invite a collaborator to the current repo. The mode is uppercase and defaults to `WRITE`. `dv invite accept <repo_id>` accepts a pending invitation.

### `dv share`

Currently not implemented per docs; placeholder.

### `dv lock [path]` / `dv lock -d <path> [-f]`

Hard locks. Bare `dv lock` lists locks. `dv lock <path>` acquires. `dv lock -d <path>` releases; `-f` force-releases another user's lock and requires admin. Hard locks need a Studio or Enterprise subscription — on lower tiers dv returns a 403 wrapped in boilerplate. See SKILL.md "hard locks" section for the full picture.

## File commands

All four are hidden from the top-level `dv help` listing, and `mv` / `rm` / `mkdir` take **flag** operands rather than positional ones.

### `dv ls [ref_id] [output_file]`

List filesystem contents for a revision. Both operands are positional: `ref_id` is a workspace / branch / commit ID (defaults to the current workspace revision), and the second is an optional file to write to instead of stdout.

### `dv mv --src_path <src> --dst_path <dst> [--workspace_id <id>]`

Move or rename a file or directory in the workspace. Use this rather than `mv` so Diversion tracks the rename properly.

### `dv rm --path <path> [--workspace_id <id>]`

Delete a file or directory from the workspace. Use this rather than `rm`.

### `dv mkdir --path <path> [--workspace_id <id>]`

Create a directory in the workspace.

### `dv clean [-f]`

Remove ignored **and** untracked files from the workspace — `git clean -f`'s rough equivalent. Destructive; confirm with the user before running. Without `-f` it prompts, and dv does not detect a non-TTY, so a scripted call without `-f` hangs rather than failing.

## Inspection / utility

### `dv show [ref] [--name-status] [--date <format>] [--color <mode>]`

Show details of a commit (message, author, changed files, diff). `ref` accepts a branch name, branch ID, commit ID, or tag ID and defaults to the current commit. `--name-status` gives just the `A`/`M`/`D`/`R` summary.

### `dv annotate <path>`

Show line-by-line commit attribution for a text file. Equivalent to `git blame`.

### `dv view`

Open the current workspace in the Diversion web UI in a browser.

### `dv status [paths...] [--sync-only] [--nowait] [--commit-id-only] [--no-limit]`

Workspace status. `--sync-only` reports just the sync state (useful when you don't care about the changelist). `--nowait` returns immediately rather than waiting for sync to settle. `--commit-id-only` prints just the commit ID — handy for scripts. `--no-limit` removes the changelist truncation.

### `dv log [path] [-n <num>] [--oneline] [--show-squashed] [--since <date>] [--until <date>] [--date <format>]`

Commit history. `-n` defaults to 20, max 1000. Date filters accept ISO format or relative (`"2 weeks ago"`). `--show-squashed` also lists commits that merges squashed away, so a file's history stays visible across merges — it requires a path.

### `dv diff [paths...] [--base <ref>] [--compare <ref>] [--name-status] [--color <mode>]`

Diff. Without flags, compares the workspace to its base commit. `--name-status` gives the summary (`A`/`M`/`D`/`R` flags). `--base` and `--compare` set arbitrary refs.

### `dv help [command]`

In-CLI help. Authoritative for the installed version of `dv`.

### `dv version`

Print the installed `dv` version.

### `dv login` / `dv logout` / `dv authenticate <token>`

Authenticate. `dv login` opens a browser flow. `dv authenticate` takes a Diversion API token (`dvk_...`) or a previously-issued OAuth refresh token — the non-interactive path for CI and headless agents. Named tokens are generated and revoked in the Diversion desktop app.

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
