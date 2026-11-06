//! Where a root sits in its repository, and the branch and HEAD state there.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::exec::{self, Mode};
use super::remote::{self, RemoteInfo};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// `None` before the first commit.
    pub sha: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    /// Commits on the branch that its upstream lacks, and the other way round, as of the last fetch.
    pub ahead: u32,
    pub behind: u32,
    /// What the upstream branch pointed at when last fetched or pushed: the pull request chip
    /// looks again when it moves.
    pub upstream_sha: Option<String>,
    /// The upstream's remote, `.` for a local upstream; not derived from `upstream`, which a `/`
    /// in a remote name would mislead.
    #[serde(skip)]
    pub upstream_remote: Option<String>,
    /// The remote-tracking ref of the upstream (`refs/remotes/origin/main`).
    #[serde(skip)]
    pub upstream_ref: Option<String>,
    /// The remote the branch syncs with (see [`remote::read`]); `None` when detached or without remotes.
    pub remote: Option<RemoteInfo>,
    /// What stopped midway and waits to be finished in a terminal.
    pub operation: Option<Operation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

/// What in a git dir says an operation is under way. `rebase-*` are folders, and a rebase may leave
/// `CHERRY_PICK_HEAD` too, so they come first.
pub const OPERATION_MARKERS: [(&str, Operation); 6] = [
    ("rebase-merge", Operation::Rebase),
    ("rebase-apply", Operation::Rebase),
    ("MERGE_HEAD", Operation::Merge),
    ("CHERRY_PICK_HEAD", Operation::CherryPick),
    ("REVERT_HEAD", Operation::Revert),
    ("BISECT_LOG", Operation::Bisect),
];

pub(super) fn operation_in(git_dir: &Path) -> Option<Operation> {
    OPERATION_MARKERS.iter().find(|(marker, _)| git_dir.join(marker).exists()).map(|(_, operation)| *operation)
}

/// Where a root sits in its repository; fixed for the root's lifetime, so resolved once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// Path of the root inside its repository: `""` at the top, else ending in `/`.
    pub prefix: String,
    /// Holds `HEAD` and `index` (`.git/worktrees/<name>` for a linked worktree).
    pub git_dir: PathBuf,
    /// Holds refs and config, shared by a repository's worktrees.
    pub common_dir: PathBuf,
}

/// The repository `root` belongs to; `None` outside one.
pub fn info(git: &Path, root: &Path) -> Result<Option<RepoInfo>, String> {
    let args = exec::args(&[&"rev-parse", &"--show-prefix", &"--absolute-git-dir", &"--git-common-dir"]);
    let out = exec::run_with(git, root, &args, Mode::Background, &Default::default())?;
    if !out.success() {
        return if out.stderr.contains("not a git repository") { Ok(None) } else { Err(exec::failure_message(&out)) };
    }
    let text = out.stdout_str()?;
    let mut lines = text.split('\n');
    let (Some(prefix), Some(git_dir), Some(common_dir)) = (lines.next(), lines.next(), lines.next()) else {
        return Err(format!("unexpected git rev-parse output: {text:?}"));
    };
    // `--git-common-dir` may be relative to `root`; joining keeps an absolute one as it is.
    Ok(Some(RepoInfo { prefix: prefix.to_owned(), git_dir: git_dir.into(), common_dir: root.join(common_dir) }))
}

/// Branch, HEAD and upstream of the repository `root` belongs to, without scanning the working
/// tree (cheap enough to refresh on every HEAD change); `None` outside a repository.
#[cfg(test)]
pub fn head(git: &Path, root: &Path) -> Result<Option<RepoState>, String> {
    let Some(info) = info(git, root)? else { return Ok(None) };
    head_in(git, root, &info).map(Some)
}

/// [`head`] for a `root` known to be in a repository.
pub fn head_in(git: &Path, root: &Path, info: &RepoInfo) -> Result<RepoState, String> {
    // Each of these exits non-zero for a legitimate "none": detached HEAD, no commits, no upstream.
    let optional = |args: &[&dyn AsRef<std::ffi::OsStr>]| -> Result<Option<String>, String> {
        let out = exec::run_with(git, root, &exec::args(args), Mode::Background, &Default::default())?;
        let text = out.stdout_str()?.trim();
        Ok((out.success() && !text.is_empty()).then(|| text.to_owned()))
    };
    let branch = optional(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"])?;
    let sha = optional(&[&"rev-parse", &"-q", &"--verify", &"HEAD"])?;
    let mut state = RepoState::new(branch, sha);
    state.operation = operation_in(&info.git_dir);
    if let Some(branch) = &state.branch {
        let reference = format!("refs/heads/{branch}");
        let format = "--format=%(upstream:short)%00%(upstream:track,nobracket)%00%(upstream)%00%(upstream:remotename)";
        let line = optional(&[&"for-each-ref", &format, &reference])?;
        if let Some(line) = line {
            let mut fields = line.split('\0');
            let mut next = || fields.next().filter(|f| !f.is_empty()).map(str::to_owned);
            state.upstream = next();
            (state.ahead, state.behind) = parse_track(&next().unwrap_or_default());
            (state.upstream_ref, state.upstream_remote) = (next(), next());
        }
    }
    add_remote(git, root, &mut state)?;
    Ok(state)
}

/// Fills in the remote a branch syncs with; none for a detached HEAD.
pub(super) fn add_remote(git: &Path, root: &Path, state: &mut RepoState) -> Result<(), String> {
    let remote = remote::read(git, root, state.branch.as_deref())?;
    state.remote = if state.detached { None } else { remote };
    // `status --porcelain` names the upstream only by its short name.
    if let (Some(branch), Some(_), None) = (&state.branch, &state.upstream, &state.upstream_ref) {
        let reference = format!("refs/heads/{branch}");
        let format = "--format=%(upstream)%00%(upstream:remotename)";
        let out = exec::run_with(git, root, &exec::args(&[&"for-each-ref", &format, &reference]), Mode::Background, &Default::default())?;
        let mut fields = out.stdout_str()?.trim_end_matches('\n').split('\0');
        let mut next = || fields.next().filter(|f| !f.is_empty()).map(str::to_owned);
        (state.upstream_ref, state.upstream_remote) = (next(), next());
    }
    // Only a remote-tracking branch has a lease to give; a local upstream branch is not on a remote.
    let on_remote = state.upstream_remote.as_deref().is_some_and(|r| r != ".");
    if let (Some(reference), true, Some(_)) = (&state.upstream_ref, on_remote, &state.remote) {
        let out = exec::run_with(git, root, &exec::args(&[&"rev-parse", &"-q", &"--verify", &reference]), Mode::Background, &Default::default())?;
        state.upstream_sha = out.success().then(|| out.stdout_str().map(|t| t.trim().to_owned())).transpose()?.filter(|t| !t.is_empty());
    }
    Ok(())
}

impl RepoState {
    pub(super) fn new(branch: Option<String>, sha: Option<String>) -> RepoState {
        RepoState {
            detached: branch.is_none(),
            branch,
            sha,
            upstream: None,
            ahead: 0,
            behind: 0,
            upstream_sha: None,
            upstream_remote: None,
            upstream_ref: None,
            remote: None,
            operation: None,
        }
    }
}

/// `ahead 2, behind 1` (any part may be missing; `gone` means no counts) → `(2, 1)`.
fn parse_track(track: &str) -> (u32, u32) {
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// Full message of the last commit, for amending it; `None` before the first commit.
pub fn last_commit_message(git: &Path, root: &Path) -> Result<Option<String>, String> {
    let out = exec::run_with(git, root, &exec::args(&[&"log", &"-1", &"--format=%B"]), Mode::Background, &Default::default())?;
    Ok(out.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::tests::status_of;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    #[test]
    fn tells_which_operation_is_in_progress() {
        let repo = TestRepo::with_commit("operation");
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        let git = git_bin();
        let operation = || status_of(&repo.path).repo.operation;
        let head_operation = || head(&git, &repo.path).unwrap().unwrap().operation;
        assert_eq!((operation(), head_operation()), (None, None));

        repo.git(&["checkout", "-qb", "side"]);
        repo.write("README.md", "side\n");
        repo.git(&["commit", "-qam", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("README.md", "main\n");
        repo.git(&["commit", "-qam", "main"]);

        for (start, abort, expected) in [
            (["merge", "side"], ["merge", "--abort"], Operation::Merge),
            (["cherry-pick", "side"], ["cherry-pick", "--abort"], Operation::CherryPick),
            (["rebase", "side"], ["rebase", "--abort"], Operation::Rebase),
        ] {
            let [command, branch] = start;
            let out = exec::run_with(&git, &repo.path, &exec::args(&[&command, &branch]), Mode::Local, &exec::Options::default()).unwrap();
            assert!(!out.success(), "{start:?} stops at the conflict");
            assert_eq!((operation(), head_operation()), (Some(expected), Some(expected)), "{start:?}");
            repo.git(&abort);
            assert_eq!(operation(), None, "{abort:?}");
        }
    }

    #[test]
    fn head_agrees_with_status_without_scanning_files() {
        let git = git_bin();
        let same = |root: &Path| assert_eq!(head(&git, root).unwrap(), Some(status_of(root).repo));

        let repo = TestRepo::new("head");
        same(&repo.path); // no commits yet
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "a"]);
        same(&repo.path);

        repo.git(&["branch", "base"]);
        repo.git(&["branch", "-q", "--set-upstream-to=base"]);
        repo.write("a.txt", "ahead");
        repo.git(&["commit", "-qam", "ahead"]);
        repo.git(&["switch", "-q", "base"]);
        repo.write("b.txt", "behind");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base moves"]);
        repo.git(&["switch", "-q", "main"]);
        let state = head(&git, &repo.path).unwrap().unwrap();
        assert_eq!((state.ahead, state.behind), (1, 1));
        same(&repo.path);

        repo.git(&["switch", "-q", "--detach"]);
        same(&repo.path);

        let plain = temp_dir("head-plain");
        assert_eq!(head(&git, &plain).unwrap(), None);
        std::fs::remove_dir_all(plain).unwrap();
    }

    #[test]
    fn last_commit_message_for_amend() {
        let git = git_bin();
        let empty = TestRepo::new("msg-empty");
        assert_eq!(last_commit_message(&git, &empty.path).unwrap(), None);
        let repo = TestRepo::with_commit("msg");
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "Subject line", "-m", "Body paragraph."]);
        assert_eq!(last_commit_message(&git, &repo.path).unwrap().as_deref(), Some("Subject line\n\nBody paragraph."));
    }
}
