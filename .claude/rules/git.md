---
paths:
  - "src-tauri/src/git/**"
  - "src-tauri/src/commands/git.rs"
  - "src/hooks/git/**"
  - "src/stores/git/git.js"
  - "src/controllers/{changes-review,session-changes}/**"
  - "src/components/changes-*/**"
  - "docs/specs/agent-git.md"
---

# Git: commit, worktrees, frontend, cache

- Commit (`git/commit.rs`, `git_commit`): the files picked in Changes go in as they are in the
  working tree (`commit --only`, untracked ones staged first and unstaged again if it fails, both
  sides of a rename); whatever else is staged stays staged and out. Amend with no files rewords
  only. During a merge, cherry-pick or revert (no partial commits) the picks are staged and the
  whole index committed. Paths go through stdin (`--pathspec-from-file`, `update-index --stdin`),
  never argv; never pass an empty pathspec file (git then commits the whole index). Hooks and
  filters run under `Mode::Hooks`: 10 min timeout, own session and process group (no controlling
  terminal, so ssh fails instead of prompting; `Mode::Remote` too), stopped with SIGTERM first
  so git removes `index.lock`. The tail of their output is the snackbar's error; it isn't logged.
- `worktree` backs worktree sessions (`add` / `attach` check out under `Mode::Hooks`: a big
  tree, LFS or a `post-checkout` hook outlast 10 s). `apply` backs a worktree session's Apply
  Locally (`session_apply_locally`: its commits and uncommitted work since `baseCommit` as an
  unstaged patch, `--3way` with a conflict list when the project moved on; applied from the
  project's folder, so changes outside it are left out) and Check Out Branch
  (`session_check_out_branch`: refused while the worktree is dirty, which a checkout would leave
  behind; stops the agent, detaches the worktree). Both are refused mid-turn and hold the turn
  slot while they run (`SlotGuard`), so no prompt starts under them. A worktree whose
  branch is checked out elsewhere doesn't start (`prepare`) until it can switch back to it. A
  dirty worktree is removed only after its work was committed (`remove_saved`).
- Frontend: the `git` hook (`hooks/git/git.js`) writes `stores/git/git.js` for the active root.
  `$gitRepo` (branch, upstream; `git_head`, no file scan) is kept current while a project is open:
  root change, `fs-change` with `git: true`, window focus. `$gitChanges` (changed files; `git_status`
  scans the working tree) is computed **only on demand**: `git.watchChanges()` starts it and
  keeps it fresh on every `fs-change` until the returned stop function runs — `<acp-git-changes>`
  (`views/git-changes/`) watches while Changes is the side pane's shown pane (`active`), `ChangesReviewController` (in `<acp-changes-tab>`) while the Changes tab is active
  (`<acp-git-changes>` also forgets picks of files no longer changed). Stopping
  keeps the files in the store; the spinner shows only for a root's first status. The files picked
  for the next commit are `$commitSelection` (root-relative paths), shared by both. Changes are files
  only: `git status --untracked-files=all` lists new folders file by file. `$gitHead` changes only when HEAD moves; the editor
  reloads its diff baselines on it.
- **Cached git state** (`git/cache.rs`, one `GitCache` per `Root`): `git_head` / `git_status` reuse the
  last answer while the root's change epoch (bumped by the watcher after every batch that changed
  something) and a fingerprint of the repository files (mtime/size of `HEAD`, `index`, the HEAD ref,
  the upstream ref, `packed-refs`, `config`, `FETCH_HEAD`, `info/exclude` — covers a git dir outside the
  root) are
  unchanged. `git_status` takes the caller's `since` version and replies `unchanged` without the
  files; the frontend then keeps the same `files` array, so views neither rebuild nor re-read diffs.
  Refresh passes `force`. Changes inside ignored folders don't bump the epoch.
