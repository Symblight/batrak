//! Reverting one changed file to HEAD from the Changes tab.

use std::ffi::OsStr;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::exec::{self, Mode, Options};
use super::lock::with_mutation;
use super::temp_file::TempFile;

/// Where the work a revert throws away stays reachable: each ref holds a tree, not a commit, so it
/// shows in no one's history. There's no undo yet; `git show <ref>:<path>` gets the file back.
const SAVED_REFS: &str = "refs/batrak/reverted";

/// Makes `paths` (relative to `root`, already checked; both sides of a rename) match HEAD, in the
/// index and the working tree, deleting what HEAD doesn't have. Conflicted files are refused. The
/// work goes into a new ref first, whose name is returned. All of it is git's doing, which never
/// follows a path through a symlink, and a second run changes nothing but the saved ref.
pub fn revert_file(git: &Path, root: &Path, paths: &[&str]) -> Result<String, String> {
    let run = |args: &[&dyn AsRef<OsStr>], mode: Mode| run(git, root, args, mode, &Options::default());
    with_mutation(git, root, || {
        for path in paths {
            if !run(&[&"--literal-pathspecs", &"ls-files", &"-u", &"--", path], Mode::Local)?.is_empty() {
                return Err(format!("{path} has a conflict: resolve it first"));
            }
        }
        let head = exec::run_with(git, root, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &"HEAD^{commit}"]), Mode::Local, &Options::default())?.success();
        let saved = save_work(git, root, head, paths)?;
        for path in paths {
            let in_head = head && !run(&[&"--literal-pathspecs", &"ls-tree", &"-z", &"--name-only", &"HEAD", &"--", path], Mode::Local)?.is_empty();
            if in_head {
                // Smudge filters (LFS) run, so the long timeout.
                run(&[&"--literal-pathspecs", &"restore", &"--source=HEAD", &"--staged", &"--worktree", &"--", path], Mode::Hooks)?;
            } else {
                run(&[&"--literal-pathspecs", &"rm", &"-q", &"--cached", &"-f", &"--ignore-unmatch", &"--", path], Mode::Local)?;
                // `-x`: this file was asked for by name, ignored or not.
                run(&[&"--literal-pathspecs", &"clean", &"-q", &"-f", &"-x", &"--", path], Mode::Local)?;
            }
        }
        Ok(saved)
    })
}

/// Writes HEAD's tree with `paths` as they are now, from a scratch index, into a new ref.
fn save_work(git: &Path, root: &Path, head: bool, paths: &[&str]) -> Result<String, String> {
    let index = TempFile::new("index");
    let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.path.as_os_str())];
    let scratch = Options { env: &env, ..Default::default() };
    let list: Vec<u8> = paths.iter().flat_map(|p| p.bytes().chain([0])).collect();
    if head {
        run(git, root, &[&"read-tree", &"HEAD"], Mode::Local, &scratch)?;
    }
    // Takes the literal paths, removes what's gone; clean filters (LFS) run, so the long timeout.
    let stage = Options { env: &env, input: Some(&list), ..Default::default() };
    run(git, root, &[&"update-index", &"--add", &"--remove", &"-z", &"--stdin"], Mode::Hooks, &stage)?;
    let tree = run(git, root, &[&"write-tree"], Mode::Local, &scratch)?;
    let tree = String::from_utf8_lossy(&tree).trim().to_owned();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| format!("the clock is before 1970: {e}"))?.as_nanos();
    let saved = format!("{SAVED_REFS}/{stamp}");
    run(git, root, &[&"update-ref", &saved, &tree], Mode::Local, &Options::default())?;
    Ok(saved)
}

fn run(git: &Path, root: &Path, args: &[&dyn AsRef<OsStr>], mode: Mode, opts: &Options) -> Result<Vec<u8>, String> {
    let out = exec::run_with(git, root, &exec::args(args), mode, opts)?;
    if out.success() { Ok(out.stdout) } else { Err(exec::failure_message(&out)) }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::git::test_repo::{git_bin, TestRepo};

    fn revert(root: &Path, paths: &[&str]) -> Result<String, String> {
        revert_file(&git_bin(), root, paths)
    }

    fn status(repo: &TestRepo) -> String {
        repo.git(&["status", "--porcelain", "--untracked-files=all"])
    }

    fn read(repo: &TestRepo, rel: &str) -> String {
        fs::read_to_string(repo.path.join(rel)).unwrap()
    }

    #[test]
    fn a_modified_file_goes_back_to_head_staged_and_unstaged_edits_alike_and_its_work_stays_in_git() {
        // Arrange
        let repo = TestRepo::with_commit("revert-modified");
        repo.write("README.md", "staged\n");
        repo.git(&["add", "README.md"]);
        repo.write("README.md", "and more\n");
        repo.write("other.txt", "keep me\n");
        // Act
        let saved = revert(&repo.path, &["README.md"]).unwrap();
        // Assert
        assert_eq!(read(&repo, "README.md"), "hello\n");
        assert_eq!(status(&repo).trim(), "?? other.txt", "only that file changed");
        assert_eq!(repo.git(&["show", &format!("{saved}:README.md")]), "and more\n");
        assert!(saved.starts_with("refs/batrak/reverted/"), "{saved}");
    }

    #[test]
    fn a_rename_restores_the_old_path_and_removes_the_new_one() {
        // Arrange
        let repo = TestRepo::with_commit("revert-rename");
        repo.git(&["mv", "README.md", "NEW.md"]);
        repo.write("NEW.md", "edited\n");
        // Act
        let saved = revert(&repo.path, &["NEW.md", "README.md"]).unwrap();
        // Assert
        assert_eq!(read(&repo, "README.md"), "hello\n");
        assert!(!repo.path.join("NEW.md").exists());
        assert_eq!(status(&repo), "");
        assert_eq!(repo.git(&["show", &format!("{saved}:NEW.md")]), "edited\n");
    }

    #[test]
    fn a_new_file_is_deleted_whether_or_not_it_was_staged_and_stays_in_git() {
        for staged in [false, true] {
            // Arrange
            let repo = TestRepo::with_commit("revert-new");
            repo.write("dir/new.txt", "new\n");
            if staged {
                repo.git(&["add", "dir/new.txt"]);
            }
            // Act
            let saved = revert(&repo.path, &["dir/new.txt"]).unwrap();
            // Assert
            assert!(!repo.path.join("dir/new.txt").exists(), "staged: {staged}");
            assert_eq!(status(&repo), "", "staged: {staged}");
            assert_eq!(repo.git(&["show", &format!("{saved}:dir/new.txt")]), "new\n", "staged: {staged}");
        }
    }

    #[test]
    fn a_new_file_that_is_ignored_but_was_force_added_is_deleted_too() {
        // Arrange
        let repo = TestRepo::with_commit("revert-ignored");
        repo.write(".gitignore", "*.log\n");
        repo.write("kept.log", "stays\n");
        repo.write("a.log", "log\n");
        repo.git(&["add", "-f", "a.log"]);
        // Act
        revert(&repo.path, &["a.log"]).unwrap();
        // Assert
        assert!(!repo.path.join("a.log").exists());
        assert_eq!(read(&repo, "kept.log"), "stays\n");
    }

    #[test]
    fn a_deleted_file_comes_back_and_reverting_it_again_changes_nothing() {
        // Arrange
        let repo = TestRepo::with_commit("revert-deleted");
        fs::remove_file(repo.path.join("README.md")).unwrap();
        // Act
        revert(&repo.path, &["README.md"]).unwrap();
        revert(&repo.path, &["README.md"]).unwrap();
        // Assert
        assert_eq!(read(&repo, "README.md"), "hello\n");
        assert_eq!(status(&repo), "");
    }

    #[test]
    fn a_conflicted_file_is_refused_and_keeps_its_merge_state() {
        // Arrange
        let repo = TestRepo::with_commit("revert-conflict");
        repo.git(&["checkout", "-qb", "side"]);
        repo.write("README.md", "side\n");
        repo.git(&["commit", "-qam", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("README.md", "main\n");
        repo.git(&["commit", "-qam", "main"]);
        let _ = std::process::Command::new(git_bin()).args(["merge", "side"]).current_dir(&repo.path).output().unwrap();
        let before = read(&repo, "README.md");
        // Act
        let err = revert(&repo.path, &["README.md"]).unwrap_err();
        // Assert
        assert!(err.contains("conflict"), "{err}");
        assert_eq!(read(&repo, "README.md"), before);
        assert!(status(&repo).starts_with("UU"), "{}", status(&repo));
    }

    #[test]
    fn paths_are_literal_and_relative_to_a_root_inside_the_repository() {
        // Arrange
        let repo = TestRepo::with_commit("revert-literal");
        repo.write("sub/*.txt", "star\n");
        repo.write("sub/:x.txt", "colon\n");
        repo.write("sub/kept.txt", "kept\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "sub"]);
        repo.write("sub/*.txt", "star edited\n");
        repo.write("sub/kept.txt", "kept edited\n");
        repo.write("sub/:new.txt", "new\n");
        let root = repo.path.join("sub");
        // Act
        revert(&root, &["*.txt"]).unwrap();
        revert(&root, &[":new.txt"]).unwrap();
        // Assert
        assert_eq!(read(&repo, "sub/*.txt"), "star\n");
        assert_eq!(read(&repo, "sub/kept.txt"), "kept edited\n", "`*.txt` is that file, not a glob");
        assert!(!repo.path.join("sub/:new.txt").exists());
    }

    #[test]
    fn a_new_file_goes_away_in_a_repository_with_no_commits() {
        // Arrange
        let repo = TestRepo::new("revert-unborn");
        repo.write("new.txt", "new\n");
        // Act
        let saved = revert(&repo.path, &["new.txt"]).unwrap();
        // Assert
        assert!(!repo.path.join("new.txt").exists());
        assert_eq!(repo.git(&["show", &format!("{saved}:new.txt")]), "new\n");
    }

    #[test]
    fn saved_work_does_not_upset_a_log_of_all_refs() {
        // Arrange
        let repo = TestRepo::with_commit("revert-log");
        repo.write("README.md", "edited\n");
        // Act
        revert(&repo.path, &["README.md"]).unwrap();
        // Assert
        assert_eq!(repo.git(&["log", "--all", "--format=%s"]).trim(), "init", "no extra commits in the user's history");
    }

    #[cfg(unix)]
    #[test]
    fn a_path_through_a_symlink_never_touches_the_folder_it_points_to() {
        // Arrange
        let repo = TestRepo::with_commit("revert-symlink");
        let outside = crate::git::test_repo::temp_dir("revert-symlink-outside");
        fs::write(outside.join("secret.txt"), "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, repo.path.join("link")).unwrap();
        // Act
        let _ = revert(&repo.path, &["link/secret.txt"]);
        // Assert
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "secret\n");
        fs::remove_dir_all(&outside).unwrap();
    }
}
