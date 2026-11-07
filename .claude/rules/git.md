---
paths:
  - "apps/desktop/src-tauri/src/git/**"
  - "apps/desktop/src-tauri/src/commands/git.rs"
  - "apps/desktop/src/hooks/git/**"
  - "apps/desktop/src/stores/git/git.js"
  - "apps/desktop/src/controllers/{changes-review,workspace-changes}/**"
  - "apps/desktop/src/components/changes-*/**"
  - "docs/specs/agent-git.md"
---

# Git: commit, worktrees, frontend, cache

- Revert (`bt_core::git::revert`, `git_revert_files`): a row's Revert, or `<acp-changes-menu>`'s Rollback for
  the picked files (Changes tab and pane; `git.revertAsking()`), of the project back to HEAD, index and working tree, a rename's two
  sides together; what HEAD doesn't have is deleted. One conflicted file refuses them all. Its view
  asks first; reverted files are unpicked. The work goes into a new
  `refs/batrak/reverted/<nanos>` first (a tree, so no one's history shows it; no undo yet:
  `git show <ref>:<path>`). Worktree sessions' tabs have no Revert.
- Commit (`git/commit.rs`, `git_commit`): the files picked in Changes go in as they are in the
  working tree (`commit --only`, untracked ones staged first and unstaged again if it fails, both
  sides of a rename); whatever else is staged stays staged and out. Amend with no files rewords
  only. During a merge, cherry-pick or revert (no partial commits) the picks are staged and the
  whole index committed. Paths go through stdin (`--pathspec-from-file`, `update-index --stdin`),
  never argv; never pass an empty pathspec file (git then commits the whole index). Hooks and
  filters run under `Mode::Hooks`: 10 min timeout, own session and process group (no controlling
  terminal, so ssh fails instead of prompting), stopped with SIGTERM first
  so git removes `index.lock`. The tail of their output is the snackbar's error; it isn't logged.
- Compare to (`bt_core::git::compare`, `git_compare`, `git_file_at_rev`; spec `docs/specs/git-compare-to.md`): the branch card's menu shows, in the Changes pane and tab, what the shown folder has against a branch, from their merge base, commits and uncommitted work together. `$gitCompare` is apart from `$gitChanges`, which goes on meaning local changes: Rollback, the picks and the composer's hint act on those. `$shownChanges` is what both views list; `read-only` there means no picks, Revert or Rollback. Picks and refreshes share one `SerialTask`: a pick supersedes whatever is running and asks at once, which stops that scan in the backend; refreshes run one at a time and never stop each other, or a scan longer than the wait would never finish while an agent writes. Per window and root; not saved. Targets go by full ref, since a bare name takes a tag of the same name first; `git_branches` lists such a branch as `heads/x`, which `compare_to` also accepts, and New worktree relies on that name staying as it is.
- Staging a conflicted file marks it resolved, so a pick that still has conflict markers is refused,
  with or without a merge in progress. An operation stopped midway (`RepoState.operation`) is finished in a
  terminal; the Changes pane only says so.
- `exec` runs every git in its own session and process group, stopped with SIGTERM first on a timeout. Its
  output is read with a grace after git is gone: a child left behind doesn't hold the call. `Hooks` and
  `Network` take no slot of `MAX_CONCURRENT`. `Background` never runs a program named by `core.fsmonitor` (a status keeps git's own daemon, `core.fsmonitor=true`);
  filters still run.
- `worktree` backs workspaces (`workspace/checkout.rs`; `add` / `attach` check out under `Mode::Hooks`: a big
  tree, LFS or a `post-checkout` hook outlast 10 s). `apply` backs a workspace's Apply
  to Main (`workspace_apply_locally`: its commits and uncommitted work since `baseCommit` as an
  unstaged patch, `--3way` with a conflict list when the project moved on; applied from the
  project's folder, so changes outside it are left out) and Check Out Branch
  (`workspace_check_out_branch`: refused while the worktree is dirty, which a checkout would leave
  behind; stops its chats' agents, detaches the worktree). Both are refused mid-turn and hold the turn
  slot while they run (`SlotGuard`), so no prompt starts under them. A worktree whose
  branch is checked out elsewhere doesn't start (`checkout::back_on_branch`, from a chat's
  `prepare`) until it can switch back to it. A
  dirty worktree is removed only after its work was committed (`remove_saved`).
- Frontend: the `git` hook (`hooks/git/git.js`) writes `stores/git/git.js` for the active root.
  `$gitRepo` (branch, upstream; `git_head`, no file scan) is kept current while a project is open:
  root change, `fs-change` with `git: true`, window focus. `$gitChanges` (changed files; `git_status`
  scans the working tree) is computed **only on demand**: `git.watchChanges()` starts it and
  keeps it fresh on every `fs-change` until the returned stop function runs — `<acp-git-changes>`
  (`views/git-changes/`) watches while Changes is the side pane's shown pane (`active`), `ChangesReviewController` (in `<acp-changes-tab>`) while the Changes tab is active
  (`<acp-git-changes>` also forgets picks of files no longer changed). Stopping
  keeps the files in the store; the spinner shows only for a root's first status. The files picked
  for the next commit are `$commitSelection` (root-relative paths), shared by both. How both Changes tabs show a diff is `$diffLayout`, saved and shared
  by every window. Changes are files
  only: `git status --untracked-files=all` lists new folders file by file. `$gitHead` changes only when HEAD moves; the editor
  reloads its diff baselines on it.
- **Cached git state** (`git/cache.rs`, one `GitCache` per `Root`): `git_head` / `git_status` reuse the
  last answer while the root's change epoch (bumped by the watcher after every batch that changed
  something) and a fingerprint of the repository files (mtime/size of `HEAD`, `index`, the HEAD ref,
  the upstream ref, `packed-refs`, `config`, `info/exclude`, what marks an operation in progress — covers a
  git dir outside the root) are
  unchanged. `git_status` takes the caller's `since` version and replies `unchanged` without the
  files; the frontend then keeps the same `files` array, so views neither rebuild nor re-read diffs.
  Refresh passes `force`. Changes inside ignored folders don't bump the epoch.
