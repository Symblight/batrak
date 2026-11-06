//! The changed files under a root, from `git status --porcelain=v2`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode};
use super::line_counts::{add_line_counts, parse_numstat, with_rename_counts};
#[cfg(test)]
use super::repo::info;
use super::repo::{add_remote, operation_in, RepoInfo, RepoState};

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
    let daemon = uses_fsmonitor_daemon(git, root);
    let (out, numstat) = std::thread::scope(|scope| {
        let numstat = scope.spawn(|| {
            // `--relative`: paths relative to `root` and only those under it, like the status entries.
            let args = exec::args(&[&"diff", &"HEAD", &"--numstat", &"-z", &"--relative", &"--no-renames"]);
            exec::run(git, root, &args, Mode::Background)
        });
        let mut args: Vec<&dyn AsRef<OsStr>> = Vec::new();
        if daemon {
            args.extend::<[&dyn AsRef<OsStr>; 2]>([&"-c", &"core.fsmonitor=true"]);
        }
        // Every untracked file rather than one entry per new folder: the lists show files only.
        // Ignored files still stay out.
        args.extend::<[&dyn AsRef<OsStr>; 7]>([&"status", &"--porcelain=v2", &"-z", &"--branch", &"--untracked-files=all", &"--", &"."]);
        let out = exec::run(git, root, &exec::args(&args), Mode::Background);
        (out, numstat.join().unwrap_or_else(|_| Err("git diff panicked".to_owned())))
    });
    let out = out?;
    // Lossy: one file name in another encoding must not hide every other change.
    let text = String::from_utf8_lossy(&out);
    let mut status = parse(&text, &info.prefix);
    status.repo.operation = operation_in(&info.git_dir);
    add_remote(git, root, &mut status.repo)?;
    // The counts are extras: without them (a timeout, over the cap) the files still list.
    let counts = numstat.ok().filter(|_| status.repo.sha.is_some()).map_or_else(HashMap::new, |out| parse_numstat(&String::from_utf8_lossy(&out)));
    let counts = with_rename_counts(git, root, &status, counts);
    add_line_counts(root, &mut status, &counts);
    Ok(status)
}

/// Whether the repository asks for git's own fsmonitor daemon, which runs no program of its naming and
/// is what makes a status of a huge tree fast. Asked only for the status, the refresh that runs all the
/// time. Not `Background`, whose `core.fsmonitor=false` this would read back. Passing a literal `true` on, not what
/// was read, keeps a program named in the config from running even if the config changes in between.
fn uses_fsmonitor_daemon(git: &Path, root: &Path) -> bool {
    let value = exec::run(git, root, &exec::args(&[&"config", &"--type=bool", &"--get", &"core.fsmonitor"]), Mode::Local);
    value.is_ok_and(|out| String::from_utf8_lossy(&out).trim() == "true")
}

fn parse(text: &str, prefix: &str) -> Status {
    let mut repo = RepoState::new(None, None);
    repo.detached = false;
    let mut files = Vec::new();
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    let rel = |path: &str| path.strip_prefix(prefix).filter(|rest| !rest.is_empty()).map(str::to_owned);

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
            Some(b'?') => {
                let Some(path) = record.get(2..) else { continue };
                (FileKind::Untracked, "??", path, None)
            }
            _ => continue,
        };
        let Some(path) = rel(path) else { continue };
        let [x, y, ..] = *xy.as_bytes() else { continue };
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
pub(super) mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    pub(in crate::git) fn status_of(root: &Path) -> Status {
        status(&git_bin(), root).unwrap().expect("a repository")
    }

    pub(in crate::git) fn file<'a>(status: &'a Status, path: &str) -> &'a FileStatus {
        status.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} in {:?}", status.files))
    }

    #[test]
    fn outside_a_repository_is_none() {
        let dir = temp_dir("not-a-repo");
        assert_eq!(status(&git_bin(), &dir).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_name_that_is_not_utf8_doesnt_take_the_list_down() {
        let repo = TestRepo::with_commit("not-utf8");
        repo.write("edited.txt", "a\n");
        let blob = repo.git(&["hash-object", "-w", "edited.txt"]);
        let mut entry = format!("100644 {}\t", blob.trim()).into_bytes();
        entry.extend_from_slice(b"caf\xe9.txt\0");
        let opts = exec::Options { input: Some(&entry), ..Default::default() };
        let args = exec::args(&[&"update-index", &"-z", &"--index-info"]);
        assert!(exec::run_with(&git_bin(), &repo.path, &args, Mode::Local, &opts).unwrap().success());

        let s = status_of(&repo.path);
        assert!(s.files.iter().any(|f| f.path.starts_with("caf")), "{:?}", s.files);
        assert_eq!(file(&s, "edited.txt").kind, FileKind::Untracked);
    }

    #[cfg(unix)]
    #[test]
    fn a_refresh_doesnt_run_the_repositorys_fsmonitor_hook() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_commit("fsmonitor");
        let dir = temp_dir("fsmonitor-hook");
        let (hook, ran) = (dir.join("hook"), dir.join("ran"));
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ran.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);

        status_of(&repo.path);

        assert!(!ran.exists(), "the hook ran on a refresh");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_refresh_keeps_gits_own_fsmonitor_daemon_and_nothing_else_the_config_names() {
        use std::os::unix::fs::PermissionsExt;
        for (value, kept) in [(Some("true"), true), (Some("1"), true), (Some("false"), false), (Some("/some/hook"), false), (None, false)] {
            let repo = TestRepo::with_commit("fsmonitor-daemon");
            if let Some(value) = value {
                repo.git(&["config", "core.fsmonitor", value]);
            }
            // Logs each call, and stops at the status: a real one would start the daemon.
            let dir = temp_dir("fsmonitor-daemon-git");
            let (fake, log) = (dir.join("git"), dir.join("log"));
            let script = format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\ncase \" $* \" in *' status '*) exit 0;; esac\nexec '{}' \"$@\"\n",
                log.display(),
                git_bin().display()
            );
            std::fs::write(&fake, script).unwrap();
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

            status(&fake, &repo.path).unwrap();

            let log = std::fs::read_to_string(&log).unwrap();
            let call = log.lines().find(|line| line.contains(" status ")).unwrap();
            assert_eq!(call.contains("-c core.fsmonitor=true"), kept, "{value:?}: {call}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_record_it_cant_read_is_skipped_and_the_others_still_list() {
        let unreadable = [
            "1",
            "1 M x",
            "1  x",
            "2 R",
            // A rename's source is its own record, and goes with it.
            "2 M x\0old.txt",
            "u M x",
            "?",
            "??",
            "? ",
            // `[2..]` would land inside the `é`.
            "?\u{e9}",
            "1 .M N... 100644 100644 100644 aaa bbb ",
        ];
        for record in unreadable {
            let text = format!("? before.txt\0{record}\0? after.txt\0");

            let status = parse(&text, "");

            let paths: Vec<&str> = status.files.iter().map(|f| f.path.as_str()).collect();
            assert_eq!(paths, ["before.txt", "after.txt"], "{record:?}");
        }
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
