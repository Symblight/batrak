//! Branch and working-tree status of the repository a root belongs to.

use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode};

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
    /// Relative to the root, `/`-separated. An untracked directory ends in `/`; `""` means the
    /// whole root is untracked.
    pub path: String,
    pub kind: FileKind,
    /// Has changes in the index.
    pub staged: bool,
    /// Has changes in the working tree not in the index.
    pub unstaged: bool,
    /// Source of a rename, when it lies inside the root.
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub repo: RepoState,
    pub files: Vec<FileStatus>,
}

/// Status of the files under `root`; `None` when `root` is not inside a git repository.
pub fn status(git: &Path, root: &Path) -> Result<Option<Status>, String> {
    let Some(prefix) = prefix(git, root)? else { return Ok(None) };
    let out = exec::run(
        git,
        root,
        &exec::args(&[
            &"status",
            &"--porcelain=v2",
            &"-z",
            &"--branch",
            &"--untracked-files=normal",
            &"--",
            &".",
        ]),
        Mode::Background,
    )?;
    let text = std::str::from_utf8(&out).map_err(|_| "git status printed non-UTF-8 paths".to_owned())?;
    Ok(Some(parse(text, &prefix)))
}

/// Path of `root` inside its repository (`""` at the top, else ending in `/`);
/// `None` outside a repository.
fn prefix(git: &Path, root: &Path) -> Result<Option<String>, String> {
    let out = exec::run_with(git, root, &exec::args(&[&"rev-parse", &"--show-prefix"]), Mode::Background, &Default::default())?;
    if out.success() {
        return Ok(Some(out.stdout_str()?.trim_end_matches('\n').to_owned()));
    }
    if out.stderr.contains("not a git repository") {
        Ok(None)
    } else {
        Err(exec::failure_message(&out))
    }
}

fn parse(text: &str, prefix: &str) -> Status {
    let mut repo = RepoState { branch: None, sha: None, detached: false, upstream: None, ahead: 0, behind: 0 };
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
        });
    }
    Status { repo, files }
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
        assert_eq!(file(&s, "untracked dir/").kind, FileKind::Untracked);
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
        assert_eq!(paths, ["Cargo.toml", "src/"]);

        repo.write("fresh/a.txt", "new");
        let s = status_of(&repo.path.join("fresh"));
        assert_eq!(s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), [""], "whole root untracked");
    }
}
