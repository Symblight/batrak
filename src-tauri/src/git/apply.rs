//! Bringing a worktree's work back to the main checkout: as a patch ("Apply Locally") or by
//! checking its branch out there ("Check Out Branch").

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::exec::{self, Mode, Options};
use super::lock::with_mutation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The worktree has no changes since `base`.
    Empty,
    /// Applied to the working tree, unstaged.
    Clean,
    /// Applied with a three-way merge: changes are staged, and these files hold conflict markers.
    Conflicts(Vec<String>),
}

/// Patch from `base` to the worktree's current files, uncommitted and untracked ones included
/// (ignored files are not). Built in a temporary index, so the worktree's own index is untouched.
pub fn changes_since(git: &Path, worktree: &Path, base: &str) -> Result<Vec<u8>, String> {
    let index = TempIndex::new();
    let env: [(&str, &std::ffi::OsStr); 1] = [("GIT_INDEX_FILE", index.path.as_os_str())];
    let opts = Options { env: &env, ..Default::default() };
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| -> Result<Vec<u8>, String> {
        let out = exec::run_with(git, worktree, &exec::args(args), Mode::Local, &opts)?;
        if out.success() { Ok(out.stdout) } else { Err(exec::failure_message(&out)) }
    };
    run(&[&"read-tree", &"HEAD"])?;
    run(&[&"add", &"-A"])?;
    run(&[&"diff", &"--cached", &"--binary", &base])
}

/// Applies the worktree's changes since `base` to the checkout at `target`. A plain apply is
/// tried first; when the target has moved on, a three-way merge leaves conflict markers.
pub fn apply_locally(git: &Path, worktree: &Path, base: &str, target: &Path) -> Result<ApplyOutcome, String> {
    with_mutation(git, target, || {
        let patch = changes_since(git, worktree, base)?;
        if patch.is_empty() {
            return Ok(ApplyOutcome::Empty);
        }
        let apply = |three_way: bool| {
            let mut args: Vec<&dyn AsRef<std::ffi::OsStr>> = vec![&"apply", &"--binary"];
            if three_way {
                args.push(&"--3way");
            }
            let opts = Options { input: Some(&patch), ..Default::default() };
            exec::run_with(git, target, &exec::args(&args), Mode::Local, &opts)
        };
        if apply(false)?.success() {
            return Ok(ApplyOutcome::Clean);
        }
        let merged = apply(true)?;
        let conflicts = exec::run(
            git,
            target,
            &exec::args(&[&"diff", &"--name-only", &"--diff-filter=U", &"-z"]),
            Mode::Local,
        )?;
        let conflicts: Vec<String> = String::from_utf8_lossy(&conflicts)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect();
        match (merged.success(), conflicts.is_empty()) {
            (_, false) => Ok(ApplyOutcome::Conflicts(conflicts)),
            (true, true) => Ok(ApplyOutcome::Clean),
            (false, true) => Err(exec::failure_message(&merged)),
        }
    })
}

/// Checks `branch` out in `target`, first detaching the worktree that holds it (git allows a
/// branch in one checkout at a time). If the switch fails the worktree gets its branch back.
pub fn check_out_branch(git: &Path, worktree: &Path, branch: &str, target: &Path) -> Result<(), String> {
    with_mutation(git, target, || {
        exec::run(git, worktree, &exec::args(&[&"switch", &"--detach"]), Mode::Local)?;
        if let Err(err) = exec::run(git, target, &exec::args(&[&"switch", &branch]), Mode::Local) {
            exec::run(git, worktree, &exec::args(&[&"switch", &branch]), Mode::Local)
                .map_err(|undo| format!("{err}; restoring the worktree's branch also failed: {undo}"))?;
            return Err(err);
        }
        Ok(())
    })
}

/// A scratch index file, deleted on drop.
struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    fn new() -> TempIndex {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name: OsString =
            format!("brama-index-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)).into();
        TempIndex { path: std::env::temp_dir().join(name) }
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, run_in, TestRepo};
    use crate::git::worktree;

    #[test]
    fn applies_uncommitted_and_untracked_work_unstaged() {
        let mut repo = TestRepo::with_commit("apply");
        let wt = repo.worktree("apply-wt", "brama/apply");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        std::fs::write(wt.join("new.rs"), "fn main() {}\n").unwrap();
        let git = git_bin();

        assert_eq!(apply_locally(&git, &wt, &base, &repo.path).unwrap(), ApplyOutcome::Clean);
        assert_eq!(std::fs::read_to_string(repo.path.join("README.md")).unwrap(), "agent edit\n");
        assert!(repo.path.join("new.rs").exists());
        assert!(repo.git(&["diff", "--cached", "--name-only"]).is_empty(), "nothing staged");
        assert!(run_in(&wt, &["diff", "--cached", "--name-only"]).is_empty(), "worktree index untouched");
    }

    #[test]
    fn nothing_to_apply() {
        let mut repo = TestRepo::with_commit("apply-empty");
        let wt = repo.worktree("apply-empty-wt", "brama/empty");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        assert_eq!(apply_locally(&git_bin(), &wt, &base, &repo.path).unwrap(), ApplyOutcome::Empty);
    }

    #[test]
    fn diverged_target_gets_conflict_markers() {
        let mut repo = TestRepo::with_commit("apply-conflict");
        let wt = repo.worktree("apply-conflict-wt", "brama/conflict");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "from agent\n").unwrap();
        repo.write("README.md", "from user\n");
        repo.git(&["commit", "-qam", "user"]);

        let outcome = apply_locally(&git_bin(), &wt, &base, &repo.path).unwrap();
        assert_eq!(outcome, ApplyOutcome::Conflicts(vec!["README.md".to_owned()]));
        assert!(std::fs::read_to_string(repo.path.join("README.md")).unwrap().contains("<<<<<<<"));
    }

    #[test]
    fn checks_out_the_worktree_branch_in_the_main_checkout() {
        let mut repo = TestRepo::with_commit("checkout");
        let wt = repo.worktree("checkout-wt", "brama/co");
        std::fs::write(wt.join("x.txt"), "x").unwrap();
        run_in(&wt, &["add", "."]);
        run_in(&wt, &["commit", "-qm", "agent"]);
        let git = git_bin();

        check_out_branch(&git, &wt, "brama/co", &repo.path).unwrap();
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "brama/co");
        assert!(repo.path.join("x.txt").exists());
        let wt_entry = worktree::list(&git, &repo.path).unwrap().into_iter().find(|e| e.path == wt).unwrap();
        assert_eq!(wt_entry.branch, None, "worktree detached");
    }

    #[test]
    fn failed_checkout_gives_the_worktree_its_branch_back() {
        let mut repo = TestRepo::with_commit("checkout-fail");
        let wt = repo.worktree("checkout-fail-wt", "brama/back");
        std::fs::write(wt.join("README.md"), "agent\n").unwrap();
        run_in(&wt, &["commit", "-qam", "agent"]);
        // A local edit the switch would overwrite.
        repo.write("README.md", "unsaved user work\n");

        assert!(check_out_branch(&git_bin(), &wt, "brama/back", &repo.path).is_err());
        assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), "brama/back");
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    }
}
