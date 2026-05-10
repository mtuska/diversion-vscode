# Diversion workflow recipes

Deeper or less-common workflows that don't fit cleanly in `SKILL.md`. The everyday ones (commit, branch+merge, shelve, hard locks, conflict resolution, undo) are in `SKILL.md`.

## First-time setup

### Cloning an existing repo

```bash
dv login                              # if not already authenticated
dv clone <repo_id_or_name> ./project  # clone to a specific path
cd project
dv status                             # confirm sync state
```

If the repo is large and you only need part of it, set up selective sync *before* the first sync finishes:

```bash
dv preferences                        # see current rules
dv preferences sync_paths_rules <rules>
```

See <https://docs.diversion.dev/advanced/selective-sync.md> for rule syntax.

### Initializing a new repo from a local directory

```bash
cd path/to/project
dv init
# follow prompts for name and default branch
```

Diversion writes a `.dvignore` tailored to the detected engine (Unreal, Unity, Godot). Review it before the first commit.

### Importing from git

```bash
cd path/to/git/repo
dv import
```

Imports full history. For Git LFS sources, see <https://docs.diversion.dev/basic/import-from-git-lfs.md> — the LFS pointers need handling.

## Draft commits and reviews

Diversion has a built-in code-review primitive called **draft commits**. Instead of merging immediately, you create a draft commit on a branch, request review, get comments, then convert it to a real commit.

The CLI surface for this is limited; most review work happens in the web UI (`dv view` to open it). The relevant doc pages:

- <https://docs.diversion.dev/basic/draft-commits.md>
- <https://docs.diversion.dev/basic/reviews.md>

If the user asks to "open a PR" or "request review", point them at draft commits — Diversion has no PR concept.

## Working with the Unreal Engine plugin

Diversion ships an UE plugin that provides source control inside the editor (Source Control panel just works, with hard-lock-aware behavior for `.uasset` and `.umap`). When the user is in UE:

- They can commit, sync, lock, and resolve conflicts from inside the editor.
- The plugin uses the `dv` daemon under the hood, so CLI and editor are consistent.
- For merge conflicts on `.uasset` files, the plugin's diff/merge view is the right tool — far better than trying to merge binary assets by hand.

If the plugin isn't installed: <https://docs.diversion.dev/unreal/unreal-engine-plugin.md>. For Horde CI integration: <https://docs.diversion.dev/unreal/horde-setup.md>.

## Working with Unity

Unity plugin is similar in spirit but smaller. <https://docs.diversion.dev/unity/unity-plugin.md>. Best practices (especially around `.meta` files, which are critical and must be committed): <https://docs.diversion.dev/unity/unity-best-practices.md>.

## CI/CD

For build-server checkouts, the pattern is:

1. Install the `dv` CLI on the build agent.
2. Authenticate non-interactively (token-based).
3. `dv clone` the repo (optionally with `--ref` to target a tag or branch).
4. Build.

Detail: <https://docs.diversion.dev/ci-cd.md>. Webhooks for triggering builds on commit: <https://docs.diversion.dev/webhooks.md>.

## Selective sync (partial workspace)

When the repo is bigger than what one developer needs locally:

```bash
dv preferences                                       # show current rules
dv preferences sync_paths_rules '+/Source/**'        # only sync Source/
dv update                                            # apply
```

Rules are similar to `.dvignore` patterns but apply per-workspace and only affect *download*, not tracking. Files outside the sync rules still exist in the repo and on the server — they're just not on your disk.

This is often combined with a per-role pattern (engineers sync `Source/`, artists sync `Content/`) to keep workspaces lean.

## Pre-commit hooks

Diversion supports pre-commit hooks similar to git, configured per-repo. They run before `dv commit` succeeds and can block the commit. See <https://docs.diversion.dev/advanced/pre-commit-hooks.md>.

To bypass for a single commit (e.g., emergency hotfix):

```bash
dv commit -a -m "hotfix" --no-verify
```

Don't bypass routinely — hooks usually exist for good reasons (lint, asset validation, lock checks).

## Pause and resume sync

When the network is flaky, when doing a large batch of edits, or when working offline:

```bash
dv workspace pause
# edit freely; nothing syncs to or from the cloud
dv workspace resume
```

Caveat: longer pauses raise the risk of sync conflicts when you resume. See the conflicts section in `SKILL.md`. After a long pause, expect to resolve some `.dv-conflict` files.

## Granular permissions

Diversion supports path-level access control (e.g., only the audio team can write to `/Audio`, everyone else is read-only). This is repo-admin territory and configured via the web UI or API:

- <https://docs.diversion.dev/basic/granular-permissions.md>
- <https://docs.diversion.dev/basic/access-levels.md>

If a `dv commit` is rejected for permission reasons even though the user is a collaborator, granular permissions are the likely cause.

## Recovering from common situations

### "I committed to the wrong branch"

```bash
dv log -n 5                           # find the commit ID
dv revert <commit_id>                 # undo it (creates a new commit)
dv checkout correct-branch
dv cherry-pick <commit_id>            # apply the original change to the right branch
dv commit -a -m "Move work to correct branch"
```

### "I want to throw out everything I've done since the last commit"

```bash
dv reset --all --clean -f
```

`--clean` also removes newly-added files. Without it, new files stay on disk but are untracked.

### "My workspace got into a weird state and I don't trust it"

```bash
dv status                             # check what it thinks is going on
dv verify                             # validate integrity
dv update                             # force a sync
```

If still bad, last resort: shelve anything you care about, delete the workspace, re-clone.

```bash
dv shelf create rescue --no-reset     # snapshot in case
# in another folder:
dv clone <repo_id> ./fresh
cd fresh
dv shelf apply rescue                 # if needed
```

### "I need to find when a regression was introduced"

Diversion doesn't have a `git bisect`-equivalent CLI as of this skill. Workflow:

1. `dv log --oneline --since "<when it worked>"` to get the commit range.
2. Use `dv checkout <commit>` to test specific commits.
3. Once found, `dv show <commit>` to see what changed.

The web UI's history view often helps narrow down faster than CLI.

## Migrating off Perforce or git

These are big workflows handled by Diversion's migration tooling and support team rather than by the CLI alone. Pointers:

- Perforce comparison and migration: <https://www.diversion.dev/compare-diversion-to-perforce>
- Git import (preserves history): `dv import` and <https://docs.diversion.dev/basic/import-from-git.md>
- Git LFS specifically: <https://docs.diversion.dev/basic/import-from-git-lfs.md>

For active production migrations, recommend the user contact Diversion support directly — there are CI pipeline considerations and depot-mapping decisions that benefit from a human.
