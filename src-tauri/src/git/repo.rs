//! Branch and working-tree status of the repository a root belongs to.

use std::collections::HashMap;
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
    pub ahead: u32,
    pub behind: u32,
    /// What the upstream branch pointed at when last fetched: the lease of a force push.
    pub upstream_sha: Option<String>,
    /// The remote the branch syncs with (see [`remote::read`]); `None` when detached or without remotes.
    pub remote: Option<RemoteInfo>,
    /// The repository has a remote at all: "No remote" against "No upstream".
    pub has_remotes: bool,
    /// Unix ms of the last fetch; `None` if it never ran.
    pub fetched_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    TypeChanged,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// A file, relative to the root, `/`-separated. Untracked folders are listed file by file.
    pub path: String,
    pub kind: FileKind,
    /// Has changes in the index.
    pub staged: bool,
    /// Has changes in the working tree not in the index.
    pub unstaged: bool,
    /// Source of a rename, when it lies inside the root.
    pub orig_path: Option<String>,
    /// Lines added against HEAD; `None` when unknown (binary, too large).
    pub added: Option<u32>,
    /// Lines removed against HEAD; `None` when unknown.
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub repo: RepoState,
    pub files: Vec<FileStatus>,
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
    if info(git, root)?.is_none() {
        return Ok(None);
    }
    let info = info(git, root)?.expect("checked above");
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
    if let Some(branch) = &state.branch {
        let reference = format!("refs/heads/{branch}");
        let line = optional(&[&"for-each-ref", &"--format=%(upstream:short)%00%(upstream:track,nobracket)", &reference])?;
        if let Some((upstream, track)) = line.as_deref().and_then(|l| l.split_once('\0')) {
            state.upstream = Some(upstream.to_owned()).filter(|u| !u.is_empty());
            (state.ahead, state.behind) = parse_track(track);
        }
    }
    add_remote(git, root, info, &mut state)?;
    Ok(state)
}

/// Fills in the remote a branch syncs with; none for a detached HEAD.
fn add_remote(git: &Path, root: &Path, info: &RepoInfo, state: &mut RepoState) -> Result<(), String> {
    let remotes = remote::read(git, root, info, state.branch.as_deref())?;
    state.has_remotes = remotes.has_remotes;
    state.fetched_at = remotes.fetched_at;
    state.remote = if state.detached { None } else { remotes.remote };
    // Only a remote-tracking branch has a lease to give; a local upstream branch is not on a remote.
    if let (Some(upstream), Some(_)) = (&state.upstream, &state.remote) {
        let reference = format!("refs/remotes/{upstream}");
        let out = exec::run_with(git, root, &exec::args(&[&"rev-parse", &"-q", &"--verify", &reference]), Mode::Background, &Default::default())?;
        state.upstream_sha = out.success().then(|| out.stdout_str().map(|t| t.trim().to_owned())).transpose()?.filter(|t| !t.is_empty());
    }
    Ok(())
}

impl RepoState {
    fn new(branch: Option<String>, sha: Option<String>) -> RepoState {
        RepoState {
            detached: branch.is_none(),
            branch,
            sha,
            upstream: None,
            ahead: 0,
            behind: 0,
            upstream_sha: None,
            remote: None,
            has_remotes: false,
            fetched_at: None,
        }
    }
}

/// Local branches a session can start from, most recently committed first; the sessions' own
/// (`brama/…`) are left out. Empty outside a repository or before the first commit.
pub fn branches(git: &Path, root: &Path) -> Result<Vec<String>, String> {
    if info(git, root)?.is_none() {
        return Ok(Vec::new());
    }
    let args = exec::args(&[&"for-each-ref", &"--sort=-committerdate", &"--format=%(refname:short)", &"refs/heads/"]);
    let out = exec::run(git, root, &args, Mode::Background)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter(|name| !name.is_empty() && !name.starts_with("brama/"))
        .map(str::to_owned)
        .collect())
}

/// Full message of the last commit, for amending it; `None` before the first commit.
pub fn last_commit_message(git: &Path, root: &Path) -> Result<Option<String>, String> {
    let out = exec::run_with(git, root, &exec::args(&[&"log", &"-1", &"--format=%B"]), Mode::Background, &Default::default())?;
    Ok(out.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_owned()))
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

/// Status of the files under `root`; `None` when `root` is not inside a git repository.
#[cfg(test)]
pub fn status(git: &Path, root: &Path) -> Result<Option<Status>, String> {
    let Some(info) = info(git, root)? else { return Ok(None) };
    status_in(git, root, &info).map(Some)
}

/// [`status`] for a `root` known to be in a repository at `prefix` (see [`RepoInfo::prefix`]).
pub fn status_in(git: &Path, root: &Path, info: &RepoInfo) -> Result<Status, String> {
    // The line counts don't depend on the status: read them alongside it. Before the first commit
    // `diff HEAD` fails, and its result is not used.
    let (out, numstat) = std::thread::scope(|scope| {
        let numstat = scope.spawn(|| {
            // `--relative`: paths relative to `root` and only those under it, like the status entries.
            let args = exec::args(&[&"diff", &"HEAD", &"--numstat", &"-z", &"--relative", &"--no-renames"]);
            exec::run(git, root, &args, Mode::Background)
        });
        let out = exec::run(
            git,
            root,
            &exec::args(&[
                &"status",
                &"--porcelain=v2",
                &"-z",
                &"--branch",
                // Every untracked file rather than one entry per new folder: the lists show files only.
                // Ignored files still stay out.
                &"--untracked-files=all",
                &"--",
                &".",
            ]),
            Mode::Background,
        );
        (out, numstat.join().unwrap_or_else(|_| Err("git diff panicked".to_owned())))
    });
    let out = out?;
    let text = std::str::from_utf8(&out).map_err(|_| "git status printed non-UTF-8 paths".to_owned())?;
    let mut status = parse(text, &info.prefix);
    add_remote(git, root, info, &mut status.repo)?;
    let counts = if status.repo.sha.is_some() { parse_numstat(&String::from_utf8_lossy(&numstat?)) } else { HashMap::new() };
    add_line_counts(root, &mut status, &counts);
    Ok(status)
}

fn parse(text: &str, prefix: &str) -> Status {
    let mut repo = RepoState::new(None, None);
    repo.detached = false;
    let mut files = Vec::new();
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    let rel = |path: &str| path.strip_prefix(prefix).map(str::to_owned);

    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            parse_header(header, &mut repo);
            continue;
        }
        let (kind, xy, path, orig) = match record.as_bytes().first() {
            Some(b'1') => {
                let fields: Vec<&str> = record.splitn(9, ' ').collect();
                let [_, xy, .., path] = fields[..] else { continue };
                (ordinary_kind(xy), xy, path, None)
            }
            Some(b'2') => {
                let fields: Vec<&str> = record.splitn(10, ' ').collect();
                let [_, xy, .., path] = fields[..] else { continue };
                // The rename source follows as its own NUL-separated record.
                (FileKind::Renamed, xy, path, records.next())
            }
            Some(b'u') => {
                let fields: Vec<&str> = record.splitn(11, ' ').collect();
                let [_, xy, .., path] = fields[..] else { continue };
                (FileKind::Conflicted, xy, path, None)
            }
            Some(b'?') => (FileKind::Untracked, "??", &record[2..], None),
            _ => continue,
        };
        let Some(path) = rel(path) else { continue };
        let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
        files.push(FileStatus {
            path,
            kind,
            staged: kind != FileKind::Untracked && x != b'.',
            unstaged: kind == FileKind::Untracked || y != b'.',
            orig_path: orig.and_then(rel),
            added: None,
            removed: None,
        });
    }
    Status { repo, files }
}

/// Untracked files larger than this get no line count.
const MAX_COUNTED_FILE: u64 = 1024 * 1024;

/// Fills `added`/`removed`: tracked files from `counts` (`git diff HEAD --numstat`, index and working
/// tree together), untracked files by counting their lines.
fn add_line_counts(root: &Path, status: &mut Status, counts: &HashMap<String, (Option<u32>, Option<u32>)>) {
    for file in &mut status.files {
        let counted = match file.kind {
            FileKind::Untracked => count_lines(&root.join(&file.path)).map(|n| (Some(n), Some(0))),
            // No HEAD yet: everything staged is new.
            FileKind::Added if status.repo.sha.is_none() => {
                count_lines(&root.join(&file.path)).map(|n| (Some(n), Some(0)))
            }
            _ => counts.get(&file.path).copied(),
        };
        if let Some((added, removed)) = counted {
            (file.added, file.removed) = (added, removed);
        }
    }
}

/// `added\tremoved\tpath\0` records; a binary file has `-` for both counts.
pub(crate) fn parse_numstat(text: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    text.split('\0')
        .filter_map(|record| {
            let mut fields = record.splitn(3, '\t');
            let (added, removed, path) = (fields.next()?, fields.next()?, fields.next()?);
            Some((path.to_owned(), (added.parse().ok(), removed.parse().ok())))
        })
        .collect()
}

/// Lines in a text file; `None` for a directory, a binary file or one over `MAX_COUNTED_FILE`.
fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COUNTED_FILE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    let unterminated = usize::from(bytes.last().is_some_and(|&b| b != b'\n'));
    u32::try_from(newlines + unterminated).ok()
}

fn parse_header(header: &str, repo: &mut RepoState) {
    let Some((key, value)) = header.split_once(' ') else { return };
    match key {
        "branch.oid" => repo.sha = (value != "(initial)").then(|| value.to_owned()),
        "branch.head" => {
            repo.detached = value == "(detached)";
            repo.branch = (!repo.detached).then(|| value.to_owned());
        }
        "branch.upstream" => repo.upstream = Some(value.to_owned()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    repo.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    repo.behind = n.parse().unwrap_or(0);
                }
            }
        }
        _ => {}
    }
}

/// Kind of an ordinary (type `1`) entry from its `XY` code; a deletion or addition on either
/// side outweighs a modification on the other.
fn ordinary_kind(xy: &str) -> FileKind {
    if xy.contains('D') {
        FileKind::Deleted
    } else if xy.contains('A') {
        FileKind::Added
    } else if xy.contains('T') {
        FileKind::TypeChanged
    } else {
        FileKind::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    fn status_of(root: &Path) -> Status {
        status(&git_bin(), root).unwrap().expect("a repository")
    }

    fn file<'a>(status: &'a Status, path: &str) -> &'a FileStatus {
        status.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} in {:?}", status.files))
    }

    #[test]
    fn outside_a_repository_is_none() {
        let dir = temp_dir("not-a-repo");
        assert_eq!(status(&git_bin(), &dir).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn before_the_first_commit() {
        let repo = TestRepo::new("initial");
        repo.write("a.txt", "a");
        let s = status_of(&repo.path);
        assert_eq!(s.repo.branch.as_deref(), Some("main"));
        assert_eq!(s.repo.sha, None);
        assert_eq!(file(&s, "a.txt").kind, FileKind::Untracked);
    }

    #[test]
    fn kinds_and_index_sides() {
        let repo = TestRepo::with_commit("kinds");
        repo.write("gone.txt", "x");
        repo.write("old name.txt", "rename me\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "more"]);

        repo.write("README.md", "changed\n");
        repo.write("staged.txt", "new");
        repo.git(&["add", "staged.txt"]);
        std::fs::remove_file(repo.path.join("gone.txt")).unwrap();
        repo.git(&["mv", "old name.txt", "новое имя.txt"]);
        repo.write("untracked dir/inner.txt", "u");

        let s = status_of(&repo.path);
        let readme = file(&s, "README.md");
        assert_eq!((readme.kind, readme.staged, readme.unstaged), (FileKind::Modified, false, true));
        let staged = file(&s, "staged.txt");
        assert_eq!((staged.kind, staged.staged, staged.unstaged), (FileKind::Added, true, false));
        assert_eq!(file(&s, "gone.txt").kind, FileKind::Deleted);
        let renamed = file(&s, "новое имя.txt");
        assert_eq!(renamed.kind, FileKind::Renamed);
        assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(file(&s, "untracked dir/inner.txt").kind, FileKind::Untracked);
        assert!(s.files.iter().all(|f| !f.path.ends_with('/')), "files only: {:?}", s.files);
    }

    #[test]
    fn conflicts() {
        let repo = TestRepo::with_commit("conflict");
        repo.git(&["switch", "-qc", "other"]);
        repo.write("README.md", "theirs\n");
        repo.git(&["commit", "-qam", "theirs"]);
        repo.git(&["switch", "-q", "main"]);
        repo.write("README.md", "ours\n");
        repo.git(&["commit", "-qam", "ours"]);
        let merge = std::process::Command::new(git_bin())
            .args(["-c", "user.name=T", "-c", "user.email=t@e", "merge", "other"])
            .current_dir(&repo.path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(!merge.status.success());
        assert_eq!(file(&status_of(&repo.path), "README.md").kind, FileKind::Conflicted);
    }

    #[test]
    fn upstream_ahead_behind_and_detached() {
        let repo = TestRepo::with_commit("ab");
        repo.git(&["branch", "base"]);
        repo.git(&["branch", "-q", "--set-upstream-to=base"]);
        repo.write("README.md", "ahead\n");
        repo.git(&["commit", "-qam", "ahead"]);
        let s = status_of(&repo.path);
        assert_eq!(s.repo.upstream.as_deref(), Some("base"));
        assert_eq!((s.repo.ahead, s.repo.behind), (1, 0));

        repo.git(&["switch", "-q", "--detach"]);
        let s = status_of(&repo.path);
        assert!(s.repo.detached);
        assert_eq!(s.repo.branch, None);
        assert!(s.repo.sha.is_some());
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
    fn line_counts_against_head() {
        let repo = TestRepo::with_commit("lines");
        repo.write("pkg/a.txt", "one\ntwo\nthree\n");
        repo.write("gone.txt", "x\ny\n");
        repo.write("bin.dat", "a\0b");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "files"]);
        repo.write("pkg/a.txt", "one\nTWO\nthree\nfour\n");
        std::fs::remove_file(repo.path.join("gone.txt")).unwrap();
        repo.write("bin.dat", "a\0c");
        repo.write("staged.txt", "s\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("new.txt", "1\n2\n3");

        let s = status_of(&repo.path);
        let counts = |path: &str| (file(&s, path).added, file(&s, path).removed);
        assert_eq!(counts("pkg/a.txt"), (Some(2), Some(1)));
        assert_eq!(counts("gone.txt"), (Some(0), Some(2)));
        assert_eq!(counts("bin.dat"), (None, None));
        assert_eq!(counts("staged.txt"), (Some(1), Some(0)));
        assert_eq!(counts("new.txt"), (Some(3), Some(0)));

        let sub = status_of(&repo.path.join("pkg"));
        assert_eq!((file(&sub, "a.txt").added, file(&sub, "a.txt").removed), (Some(2), Some(1)));

        let fresh = TestRepo::new("lines-initial");
        fresh.write("a.txt", "a\nb\n");
        fresh.git(&["add", "."]);
        let s = status_of(&fresh.path);
        assert_eq!((file(&s, "a.txt").added, file(&s, "a.txt").removed), (Some(2), Some(0)));
    }

    #[test]
    fn branches_to_start_a_session_from_leave_out_session_branches() {
        let git = git_bin();
        let dir = temp_dir("branches-none");
        assert!(branches(&git, &dir).unwrap().is_empty(), "outside a repository");
        assert!(branches(&git, &TestRepo::new("branches-empty").path).unwrap().is_empty(), "before the first commit");
        let repo = TestRepo::with_commit("branches");
        for branch in ["feature/x", "brama/session-1234"] {
            repo.git(&["branch", branch]);
        }
        let mut names = branches(&git, &repo.path).unwrap();
        names.sort();
        assert_eq!(names, ["feature/x", "main"]);
        std::fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn track_formats() {
        assert_eq!(parse_track(""), (0, 0));
        assert_eq!(parse_track("ahead 3"), (3, 0));
        assert_eq!(parse_track("behind 2"), (0, 2));
        assert_eq!(parse_track("ahead 1, behind 4"), (1, 4));
        assert_eq!(parse_track("gone"), (0, 0));
    }

    #[test]
    fn root_in_a_subdirectory_sees_only_its_files_relative_to_itself() {
        let repo = TestRepo::with_commit("prefix");
        repo.write("pkg/Cargo.toml", "[package]\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "pkg"]);
        repo.write("pkg/Cargo.toml", "[package]\nname = \"x\"\n");
        repo.write("pkg/src/lib.rs", "x");
        repo.write("other.txt", "y");
        let s = status_of(&repo.path.join("pkg"));
        let mut paths: Vec<_> = s.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["Cargo.toml", "src/lib.rs"]);

        repo.write("fresh/a.txt", "new");
        let s = status_of(&repo.path.join("fresh"));
        assert_eq!(s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"], "new root: its files");
    }
}
