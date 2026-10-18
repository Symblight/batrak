//! Worktrees for agent sessions: one directory and branch per session, outside the checkout.
//! Every change runs under the repository's mutation lock.

use std::fs;
use std::path::{Path, PathBuf};

use super::exec::{self, Mode};
use super::lock::with_mutation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    /// `None` before the first commit.
    pub head: Option<String>,
    /// Short branch name; `None` when detached.
    pub branch: Option<String>,
    pub locked: bool,
    /// Its directory is gone; `prune` drops it.
    pub prunable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchCleanup {
    /// Keep the branch, so its commits stay reachable.
    Keep,
    /// Delete the branch even if unmerged; only after the caller saved what it needs.
    Delete,
}

/// Creates `path` as a worktree of the repository at `repo` on a new `branch` starting at `base`.
pub fn add(git: &Path, repo: &Path, path: &Path, branch: &str, base: &str) -> Result<(), String> {
    check_out(git, repo, path, &[&"-b", &branch, &path, &base])
}

/// Creates `path` as a worktree of the repository at `repo` on its existing `branch` (a session's
/// folder that was deleted).
pub fn attach(git: &Path, repo: &Path, path: &Path, branch: &str) -> Result<(), String> {
    check_out(git, repo, path, &[&path, &branch])
}

/// `git worktree add` with `rest`. A checkout of a large tree, LFS filters and a `post-checkout`
/// hook can take long: `Mode::Hooks`, not the 10 s of `Mode::Local`.
fn check_out(git: &Path, repo: &Path, path: &Path, rest: &[&dyn AsRef<std::ffi::OsStr>]) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{}: already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut args: Vec<&dyn AsRef<std::ffi::OsStr>> = vec![&"worktree", &"add"];
    args.extend_from_slice(rest);
    with_mutation(git, repo, || exec::run(git, repo, &exec::args(&args), Mode::Hooks).map(drop))
}

/// Every worktree of the repository at `repo`, the main checkout first.
pub fn list(git: &Path, repo: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let out = exec::run(git, repo, &exec::args(&[&"worktree", &"list", &"--porcelain", &"-z"]), Mode::Background)?;
    let text = String::from_utf8_lossy(&out);
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    // Attributes are NUL-terminated; an empty one ends a worktree.
    for attr in text.split('\0') {
        if attr.is_empty() {
            entries.extend(current.take());
            continue;
        }
        let (key, value) = attr.split_once(' ').unwrap_or((attr, ""));
        if key == "worktree" {
            entries.extend(current.take());
            current = Some(WorktreeEntry {
                path: exec::canonical(Path::new(value)),
                head: None,
                branch: None,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else { continue };
        match key {
            "HEAD" => entry.head = Some(value.to_owned()).filter(|h| !h.trim_matches('0').is_empty()),
            "branch" => entry.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
            "locked" => entry.locked = true,
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    entries.extend(current);
    Ok(entries)
}

/// Whether the worktree at `path` has changes a removal would lose: modified, staged or
/// untracked files (ignored ones don't count).
pub fn is_dirty(git: &Path, path: &Path) -> Result<bool, String> {
    let out = exec::run(
        git,
        path,
        &exec::args(&[&"status", &"--porcelain", &"-z", &"--untracked-files=normal"]),
        Mode::Background,
    )?;
    Ok(!out.is_empty())
}

/// Removes the worktree at `path`, refusing when it has uncommitted changes; a directory that
/// is already gone is just pruned. `branch` is then deleted or kept per `cleanup`.
pub fn remove(git: &Path, repo: &Path, path: &Path, branch: Option<&str>, cleanup: BranchCleanup) -> Result<(), String> {
    with_mutation(git, repo, || {
        if path.exists() {
            if is_dirty(git, path)? {
                return Err(format!("{}: has uncommitted changes", path.display()));
            }
            exec::run(git, repo, &exec::args(&[&"worktree", &"remove", &path]), Mode::Local)?;
        } else {
            exec::run(git, repo, &exec::args(&[&"worktree", &"prune"]), Mode::Local)?;
        }
        if let (Some(branch), BranchCleanup::Delete) = (branch, cleanup) {
            exec::run(git, repo, &exec::args(&[&"branch", &"-D", &branch]), Mode::Local)?;
        }
        Ok(())
    })
}

/// Drops metadata of worktrees whose directories were deleted outside the app.
pub fn prune(git: &Path, repo: &Path) -> Result<(), String> {
    with_mutation(git, repo, || exec::run(git, repo, &exec::args(&[&"worktree", &"prune"]), Mode::Local).map(drop))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, run_in, temp_dir, TestRepo};

    #[test]
    fn add_list_remove_with_branch_cleanup() {
        let repo = TestRepo::with_commit("wt");
        let parent = temp_dir("wt-home");
        let path = parent.join("project/session-1");
        let git = git_bin();

        add(&git, &repo.path, &path, "brama/session-1", "main").unwrap();
        assert!(add(&git, &repo.path, &path, "brama/other", "main").unwrap_err().contains("already exists"));
        let entries = list(&git, &repo.path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, repo.path);
        let wt = entries.iter().find(|e| e.path == exec::canonical(&path)).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("brama/session-1"));

        // Ignored files don't block a removal.
        std::fs::write(path.join(".gitignore"), "build/\n").unwrap();
        run_in(&path, &["add", ".gitignore"]);
        run_in(&path, &["commit", "-qm", "ignore build"]);
        std::fs::create_dir_all(path.join("build")).unwrap();
        std::fs::write(path.join("build/out.bin"), "x").unwrap();

        remove(&git, &repo.path, &path, Some("brama/session-1"), BranchCleanup::Keep).unwrap();
        assert!(!path.exists());
        assert!(repo.git(&["branch", "--list", "brama/session-1"]).contains("brama/session-1"), "kept");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn refuses_to_remove_a_dirty_worktree() {
        let repo = TestRepo::with_commit("wt-dirty");
        let parent = temp_dir("wt-dirty-home");
        let path = parent.join("s");
        let git = git_bin();
        add(&git, &repo.path, &path, "brama/s", "main").unwrap();

        std::fs::write(path.join("new.txt"), "agent work").unwrap();
        let err = remove(&git, &repo.path, &path, Some("brama/s"), BranchCleanup::Delete).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(path.join("new.txt").exists());
        assert!(repo.git(&["branch", "--list", "brama/s"]).contains("brama/s"), "branch untouched");

        std::fs::remove_file(path.join("new.txt")).unwrap();
        remove(&git, &repo.path, &path, Some("brama/s"), BranchCleanup::Delete).unwrap();
        assert!(repo.git(&["branch", "--list", "brama/s"]).is_empty(), "deleted");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn attach_checks_an_existing_branch_out_again() {
        let repo = TestRepo::with_commit("wt-attach");
        let parent = temp_dir("wt-attach-home");
        let path = parent.join("s");
        let git = git_bin();
        add(&git, &repo.path, &path, "brama/attach", "main").unwrap();
        std::fs::write(path.join("work.txt"), "kept").unwrap();
        run_in(&path, &["add", "."]);
        run_in(&path, &["commit", "-qm", "agent"]);
        std::fs::remove_dir_all(&path).unwrap();
        prune(&git, &repo.path).unwrap();

        attach(&git, &repo.path, &path, "brama/attach").unwrap();
        assert_eq!(std::fs::read_to_string(path.join("work.txt")).unwrap(), "kept");
        assert_eq!(run_in(&path, &["branch", "--show-current"]).trim(), "brama/attach");
        assert!(attach(&git, &repo.path, &path, "brama/attach").unwrap_err().contains("already exists"));
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_directory_deleted_outside_is_pruned() {
        let repo = TestRepo::with_commit("wt-gone");
        let parent = temp_dir("wt-gone-home");
        let path = parent.join("s");
        let git = git_bin();
        add(&git, &repo.path, &path, "brama/gone", "main").unwrap();
        std::fs::remove_dir_all(&path).unwrap();
        assert!(list(&git, &repo.path).unwrap().iter().any(|e| e.prunable));

        remove(&git, &repo.path, &path, Some("brama/gone"), BranchCleanup::Keep).unwrap();
        assert_eq!(list(&git, &repo.path).unwrap().len(), 1);
        std::fs::remove_dir_all(parent).unwrap();
    }
}
