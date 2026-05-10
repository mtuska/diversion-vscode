---
name: diversion
description: Operate Diversion (the `dv` CLI) for source control in a Diversion repository. Use this skill any time the user asks for version-control work in a Diversion repo — committing, branching, merging, diffing, viewing history, resolving conflicts, shelving, locking binary assets, managing workspaces, or anything else that would normally be a git operation. Use it even when the user says "git" out of habit ("git status this", "commit and push") — `git` will not do what the user wants in a Diversion repo.
---

# Diversion source control

Diversion is a cloud-native VCS for game development and large-binary projects (Unreal, Unity, Maya, etc.). It looks git-shaped on the surface but has different semantics in a few places that will silently break things if you assume git behavior.

This skill covers the `dv` CLI. For deeper command reference and workflow recipes, see `references/cli-reference.md` and `references/workflows.md`. For anything not covered here, the official docs publish an LLM-friendly index at <https://docs.diversion.dev/llms.txt> — every page is also available as `.md` (e.g. `https://docs.diversion.dev/cmd-ref/commit.md`), so fetch the relevant page directly when you need authoritative detail.

## Before applying this skill: confirm it's actually a Diversion repo

A directory whose name *mentions* Diversion (e.g. an extension project, a fork, a clone of these docs) is not necessarily a Diversion repo. Confirm with `dv workspace` — it self-reports cleanly:

```
$ dv workspace
Current directory is not a diversion repository (neither is any of its parent directories).
```

vs.

```
$ dv workspace

workspace mtuskaatfrs-llc @ bazzite (dv.ws.d35deda8-6d10-...)
    branch dv.branch.1
```

If you get the "not a diversion repository" message, **stop applying this skill**. Use `git` (or whatever the project actually uses) normally. Don't refuse to run `git` just because the project name contains "diversion".

If `dv` itself isn't installed, that also means this isn't a Diversion workflow — exit cleanly.

## Binary name: `dv` vs `dv.exe`

The CLI is `dv` on macOS and Linux and `dv.exe` on Windows. On Windows the installer normally puts both on `PATH` so plain `dv` works in PowerShell and cmd as well; if a script needs an explicit extension on Windows, use `dv.exe`. All examples in this skill use `dv` — substitute as needed.

## Sanity-check habit

`dv` operations go through a local sync agent (the daemon), so `dv status` and `dv workspace` are cheap — no network round-trip per call. Run `dv status` freely before and after state-changing operations to confirm the workspace is where you think it is. The git instinct to avoid frequent `status` calls because they're expensive does not apply here.

## Mental model: five things that are not like git

Internalize these before running any command. Most Diversion mistakes come from assuming git semantics.

1. **Auto-sync — there is no push or pull.** Once you `dv commit`, the change syncs to the cloud and to teammates automatically. Do not look for `dv push`. Do not run `git push`. Workspaces also sync uncommitted changes in the background, so saving a file is enough to put it in your remote workspace mirror.

2. **Workspaces are first-class, distinct from branches.** A *workspace* is your local working copy (and its remote mirror). A *branch* is the shared line of history. A workspace is linked to one branch at a time but is its own thing — it has uncommitted changes, sync settings, and its own ID (`dv.ws.xxxxx`). Switching branches is a workspace operation (`dv checkout`). Listing workspaces is `dv workspace`.

3. **Binary files are locked, not merged.** Game projects have lots of binary assets (`.uasset`, `.umap`, `.fbx`, etc.) that cannot be three-way-merged. Diversion provides **hard locks** (`dv lock <path>`) for exclusive write access. Many repos auto-lock specific extensions on edit. Before editing a binary asset, check or take a lock — if someone else holds it, your commit will be rejected.

4. **Shelves replace `git stash`.** Use `dv shelf create <name>` to set work aside, `dv shelf apply <name>` to bring it back. Shelves are not tied to a branch — you can shelf on one branch and apply on another.

5. **There are two kinds of conflicts and they're handled differently.** *Merge conflicts* (during `dv merge`) are held in the cloud and resolved through the desktop app, not via inline conflict markers in the working tree. *Sync conflicts* (when auto-update brings in a teammate's commit that overlaps your uncommitted changes) are handled by writing your local version to a `.dv-conflict` sidecar file and overwriting the original with the incoming version. The sync-conflict resolution recipe is below; for merge conflicts, point the user at `dv view` (web UI) or the desktop app.

## Hard rules — do not do these

- **Do not run `git` commands** in a Diversion repo. There is no git remote. Best case: the command fails. Worst case: it operates on a stray local `.git` directory and confuses you and the user.
- **Do not look for `dv push` or `dv pull`.** They do not exist. Commits sync automatically.
- **Do not commit `.dv-conflict` files.** They are sync-conflict backups, not deliverables. Diversion will refuse anyway, but don't try.
- **Do not edit a hard-locked file held by another user.** Diversion will warn locally but block the commit. Coordinate first or ask an admin to release the lock.
- **Do not use `.gitignore` thinking instead of `.dvignore`.** Diversion does honor existing `.gitignore` files for compatibility, but the canonical ignore file is `.dvignore` and it takes precedence in conflicts.

## Scope work to the user's working directory

Diversion has no per-directory mode: `dv status`, `dv diff`, and `dv log` always report the whole workspace regardless of where they're run from. That doesn't mean the user wants whole-workspace operations. When the working directory is a subdir of the repo (e.g. `docs/`, `Content/Maps/`, `src/api/` inside a larger project), the user's intent is almost always "work on the files under here," not "act on everything in the repo."

Treat the cwd as a scope filter:

- **Commits.** Do not `dv commit -a` from a subdir. Pass explicit paths so only files under cwd land in the commit: `dv commit . -m "..."` (everything under cwd) or `dv commit file1 file2 -m "..."` (specific files). If `dv status` shows changes outside cwd, leave them alone — they belong to other work.
- **Diffs.** Use `dv diff .` (or specific paths) for "what did I change here" rather than `dv diff` which shows the whole workspace.
- **Status reporting.** `dv status` will list changes anywhere in the workspace; when reporting to the user, filter to paths under cwd. Don't say "you have N modified files" based on the unfiltered count.
- **Log / history.** Use `dv log .` or `dv log path/to/dir` when the user wants history for the area they're working in.
- **Discard.** `dv reset path` and `dv reset .` are safe; `dv reset --all -f` wipes the whole workspace including unrelated work — don't reach for it just because you're inside a subdir.

If the user explicitly asks for whole-workspace state ("show me everything in the repo," "is the workspace clean?"), unscope. Otherwise stay inside the directory the conversation is happening in.

## Common commands — quick reference

This is the working set. For full flags and less-common commands, see `references/cli-reference.md`.

| Task | Command |
|---|---|
| Show workspace status (modified/added/deleted, sync state) | `dv status` |
| Stage and commit everything | `dv commit -a -m "message"` |
| Commit specific files only | `dv commit path1 path2 -m "message"` |
| Skip pre-commit hooks for one commit | `dv commit -a -m "msg" --no-verify` |
| View commit history | `dv log -n 20 --oneline` |
| History for a specific path | `dv log path/to/file` |
| Show details of one commit | `dv show <commit_id>` |
| Diff workspace vs base commit | `dv diff` |
| Diff between two refs | `dv diff --base main --compare feature-x` |
| List branches | `dv branch` |
| Create a branch and switch to it | `dv branch -c feature-x` |
| Delete a branch | `dv branch -d feature-x` (`-f` to skip confirmation) |
| Rename a branch | `dv branch -r feature-x feature-y` |
| Switch to an existing branch | `dv checkout feature-x` |
| Switch branches keeping your changes | `dv checkout main --take-changes` |
| Switch branches shelving your changes | `dv checkout main --shelve-changes` |
| Merge a branch into the current branch | `dv merge feature-x` |
| Preview a merge before doing it | `dv merge-preview feature-x` |
| Discard uncommitted change to a file | `dv reset path/to/file` |
| Discard all uncommitted changes | `dv reset --all -f` |
| Discard *and* remove newly-added files | `dv reset --all --clean -f` |
| Revert the changes of a past commit (creates a new commit) | `dv revert <commit_id>` |
| Set workspace contents back to a past commit | `dv revert-to-commit <commit_id>` |
| Restore a single file from a ref | `dv restore <ref> path/to/file` |
| Cherry-pick a commit into the workspace | `dv cherry-pick <commit_id>` |
| Shelve current changes | `dv shelf create <name>` |
| List shelves | `dv shelf` |
| Apply a shelf | `dv shelf apply <name>` |
| Lock a binary asset | `dv lock path/to/Asset.uasset` |
| Release a lock | `dv lock -d path/to/Asset.uasset` |
| List locks | `dv lock` |
| Open the current workspace in the web UI | `dv view` |
| Pause background sync (e.g., on flaky network) | `dv workspace pause` |
| Resume sync | `dv workspace resume` |

## Workflow: commit changes

The 95% case. Diversion auto-tracks files in the working directory, so you do not need a `git add` step.

```bash
dv status                          # see what changed
dv commit -a -m "Descriptive msg"  # commit everything
```

That's it — no push. The commit syncs to teammates automatically. If the user asks "is it pushed?" the answer is "Diversion auto-syncs commits, so yes, it's already shared."

If only some files should be committed, name them explicitly instead of `-a`:

```bash
dv commit Source/Player.cpp Source/Player.h -m "Tighten jump arc"
```

If pre-commit hooks are configured and you need to bypass them (rare, e.g. emergency hotfix), append `--no-verify`. Do not bypass hooks routinely.

### Commit message gotcha: no dash-led bullets

Multi-line `-m` values that contain lines starting with `- ` (markdown-style bullets) are rejected by dv with a misleading error:

```
Should provide exactly one of: a list of specific paths to commit, or the `-a` option.
```

The shell quoting is fine (`-m "$(cat <<'EOF'...EOF)"` correctly passes one argv element); something later in dv's pipeline re-interprets dash-led lines inside the message body as flag tokens, then complains that "paths" and `-a` were both supplied. Reading the same body from a file with `-m "$(cat msg.txt)"` fails identically. There is no `-F <file>` flag.

Safe options for multi-line messages:

- Use `*` bullets instead of `- ` bullets.
- Indent each bullet line so it doesn't start with `-` (e.g. two leading spaces).
- Write prose paragraphs with blank lines instead of bullets.
- Or fall back to a single-line summary and put detail in the conversation / PR / `dv view` notes.

If a multi-line message is essential, sanity-check by grepping the body for `^- ` before committing:

```bash
printf '%s\n' "$MSG" | grep -nE '^- ' && echo "rewrite dash bullets before committing"
```

## Workflow: branch, work, merge

```bash
dv branch -c feature/inventory-ui   # create + switch
# edit files
dv commit -a -m "Stub inventory UI"
dv commit -a -m "Wire to player state"
dv checkout main                    # switch back
dv merge feature/inventory-ui       # bring it in
```

If the merge has conflicts, Diversion holds them in the cloud rather than writing inline conflict markers into your working tree (this differs from git). Open the desktop app or run `dv view` to launch the web UI, and resolve conflicts there. For binary files like `.uasset` that cannot be auto-merged, the desktop app is the right tool — picking a winner manually in the CLI risks data loss. Hard locks prevent binary merge conflicts in the first place when used correctly.

To clean up a finished branch:

```bash
dv branch -d feature/inventory-ui
```

## Workflow: shelve work to switch tasks

When the user has uncommitted changes and needs to context-switch:

```bash
dv shelf create wip-inventory       # save and clear workspace
dv checkout main                    # or another branch
# do the urgent thing, commit
dv checkout feature/inventory-ui
dv shelf apply wip-inventory        # restore
```

`dv checkout --shelve-changes` does the shelve-and-switch in one command. `--apply-shelf` on checkout reapplies any shelved changes the target branch had.

## Workflow: resolve a sync conflict (the `.dv-conflict` situation)

This is the failure mode that surprises people most. When auto-update brings in a teammate's commit that touches a file you also edited locally:

- Diversion writes your local version to `<filename>.dv-conflict.<ext>` (untracked).
- The original path now contains the *incoming* version.
- The desktop app shows a warning; the CLI shows it in `dv status`.

Resolution depends on file type. For **text files**:

1. Open both files side-by-side in a diff tool (VS Code's diff, Meld, etc.).
2. Apply your edits onto the original path.
3. Commit.
4. Delete the `.dv-conflict` file.

For **Unreal `.uasset` and similar binaries**, the redirector in the `.dv-conflict` file will be broken (because the filename changed), so:

1. Make sure the original file has no other pending changes (commit or reset them first).
2. Overwrite the original with the contents of the `.dv-conflict` file.
3. Open in the editor, review/merge by hand, save.
4. Commit.
5. Delete the `.dv-conflict` file.

If multiple sync conflicts have accumulated, you may see `file.dv-conflict.ext`, `file.dv-conflict-1.ext`, etc. Resolve oldest-to-newest.

`.dv-conflict*` files are untracked, so a plain `rm` (or Windows `del`) removes them — there's no `dv rm` needed.

## Workflow: hard locks for binary work

Before editing a binary asset that is unmergeable:

```bash
dv lock                                       # see what's currently locked
dv lock Content/Characters/Hero.uasset        # take an exclusive lock
# edit, commit normally
```

The lock is released either manually (`dv lock -d <path>`) or automatically on commit-to-protected-branch if the repo has auto-release configured. Many game repos have auto-lock configured for `.uasset`, `.umap`, `.fbx` so the lock happens implicitly on edit — but it's still good practice to check `dv lock` before starting work on a major asset to confirm nobody else has it.

If a teammate is unreachable and holds a blocking lock, only they or a repo admin can release it. Tell the user; do not try to force-edit.

## Workflow: undo

The choice depends on how far back the mistake is.

- **Uncommitted change to a file** → `dv reset path/to/file`
- **Wipe all uncommitted changes (incl. new files)** → `dv reset --all --clean -f`
- **Most recent commit was wrong** → `dv revert <commit_id>` (makes a new commit that inverts it; safe in shared history)
- **Want the workspace to *be* a past state, but not rewrite history** → `dv revert-to-commit <commit_id>`
- **Just want one file back to how it was at some point** → `dv restore <ref> path/to/file`

Do not look for `dv reset --hard <commit>` — Diversion's model is different. `dv revert` and `dv revert-to-commit` are the answers; both create new commits rather than rewriting history.

## The `.dvignore` file

`.dvignore` controls what Diversion **tracks**. It uses the same pattern syntax as `.gitignore` (including nested files, `**`, negation, and root-anchoring with leading `/`). Diversion also reads existing `.gitignore` files for compatibility, but `.dvignore` takes precedence when both exist in the same directory.

Two important quirks:

- **Already-committed files are not retroactively ignored.** Adding a path to `.dvignore` does nothing for files already in history. Delete + commit the deletion (and notify teammates first, because `dv update` will delete their local copies too).
- **A negation rule keeps an empty parent directory tracked.** `Build/*` plus `!Build/app.dll` keeps `Build/` tracked even if `app.dll` doesn't exist yet. To fully ignore `Build/`, remove the negation.

For game-engine projects Diversion ships engine-specific defaults (Unreal, Unity, Godot). Don't fight them unless you know why.

For partial *download* of an already-tracked tree, that is **selective sync** (a workspace preference, separate from `.dvignore`). See `dv preferences` and the docs page.

## When to fetch the official docs

This skill covers the working set. For anything specialized — granular permissions, draft commits and reviews, pre-commit hook configuration, CI/CD setup, the Unreal/Unity plugins, organization management, the REST API, Perforce import — fetch the relevant page from <https://docs.diversion.dev/llms.txt>. Each page is also available with a `.md` suffix (e.g., `https://docs.diversion.dev/basic/draft-commits.md`), which is the preferred form to fetch.

If a command behaves unexpectedly, run `dv help <command>` first — Diversion has solid in-CLI help and it'll be authoritative for the installed version.

## When `dv` commands hang or fail to connect

`dv` talks to a local sync agent (the daemon). If commands hang, time out, or report `connect ECONNREFUSED 127.0.0.1:<port>`, the daemon isn't running — not a network or auth problem. Running `dv status` will start it on demand in most installs; if not, restart the Diversion desktop app, or on a CI agent invoke whatever spawns the daemon (`dv login` is sometimes enough to kick it). A stale `~/.diversion/.port` file pointing at a dead port produces the same symptoms — deleting it forces a fresh discovery.
