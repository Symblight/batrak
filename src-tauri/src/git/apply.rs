//! Bringing a worktree's work back to the main checkout: as a patch ("Apply Locally") or by
//! checking its branch out there ("Check Out Branch").

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::exec::{self, Mode, Options, TempFile};
use super::lock::with_mutation;
use super::repo::{self, FileKind, FileStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The worktree has no changes since `base`.
    Empty,
    /// Applied to the working tree, unstaged.
    Clean,
    /// Applied with a three-way merge: changes are staged, and these files hold conflict markers.
    Conflicts(Vec<String>),
}

/// Runs git commands against a scratch index holding the worktree's files as they are now,
/// uncommitted and untracked ones included (ignored ones not). Seeded from the worktree's own index,
/// so `add -A` hashes only changed files; that index is never touched. `worktree` may be a folder in it.
fn with_snapshot<T>(
    git: &Path,
    worktree: &Path,
    f: impl FnOnce(&dyn Fn(&[&dyn AsRef<OsStr>]) -> Result<Vec<u8>, String>) -> Result<T, String>,
) -> Result<T, String> {
    let index = TempFile::new("index");
    let real = exec::run(git, worktree, &exec::args(&[&"rev-parse", &"--path-format=absolute", &"--git-path", &"index"]), Mode::Background)?;
    let seeded = std::fs::copy(PathBuf::from(String::from_utf8_lossy(&real).trim()), &index.path).is_ok();
    let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.path.as_os_str())];
    let opts = Options { env: &env, ..Default::default() };
    let run = |args: &[&dyn AsRef<OsStr>]| -> Result<Vec<u8>, String> {
        let out = exec::run_with(git, worktree, &exec::args(args), Mode::Local, &opts)?;
        if out.success() { Ok(out.stdout) } else { Err(exec::failure_message(&out)) }
    };
    if !seeded {
        run(&[&"read-tree", &"HEAD"])?;
    }
    run(&[&"add", &"-A"])?;
    f(&run)
}

/// Patch from `base` to the worktree's current files, uncommitted and untracked ones included
/// (ignored files are not). The worktree's own index is untouched.
pub fn changes_since(git: &Path, worktree: &Path, base: &str) -> Result<Vec<u8>, String> {
    with_snapshot(git, worktree, |run| run(&[&"diff", &"--cached", &"--binary", &base]))
}

/// Files under `dir` (a worktree or a folder in one; paths relative to it) that differ from
/// `base`: its commits and uncommitted work together, with line counts. Renames show as a deletion
/// and an addition. Sorted by path.
pub fn changed_since(git: &Path, dir: &Path, base: &str) -> Result<Vec<FileStatus>, String> {
    with_snapshot(git, dir, |run| {
        let diff = |format: &'static str| run(&[&"diff", &"--cached", &format, &"-z", &"--relative", &"--no-renames", &base]);
        let names = diff("--name-status")?;
        let counts = repo::parse_numstat(&String::from_utf8_lossy(&diff("--numstat")?));
        let names = String::from_utf8_lossy(&names);
        let mut fields = names.split('\0').filter(|f| !f.is_empty());
        let mut files = Vec::new();
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            let kind = match status.as_bytes().first() {
                Some(b'A') => FileKind::Added,
                Some(b'D') => FileKind::Deleted,
                Some(b'T') => FileKind::TypeChanged,
                _ => FileKind::Modified,
            };
            let (added, removed) = counts.get(path).copied().unwrap_or((None, None));
            files.push(FileStatus { path: path.to_owned(), kind, staged: false, unstaged: true, orig_path: None, added, removed });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    })
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::repo::FileKind;
    use crate::git::test_repo::{git_bin, run_in, TestRepo};
    use crate::git::{blob, worktree};

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
    fn files_changed_since_the_base_commit_and_their_text_there() {
        let mut repo = TestRepo::with_commit("since");
        for (path, text) in [("app/edit.txt", "one\n"), ("app/gone.txt", "gone\n"), ("app/keep.txt", "keep\n")] {
            repo.write(path, text);
        }
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "app"]);
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let wt = repo.worktree("since-wt", "brama/since");
        std::fs::write(wt.join("app/edit.txt"), "one\ntwo\n").unwrap();
        run_in(&wt, &["commit", "-qam", "agent"]);
        std::fs::remove_file(wt.join("app/gone.txt")).unwrap();
        std::fs::write(wt.join("app/new.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(wt.join("outside.txt"), "not the project's").unwrap();
        run_in(&wt, &["add", "app/new.txt"]);
        let git = git_bin();

        let files = changed_since(&git, &wt.join("app"), &base).unwrap();
        let summary: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed)).collect();
        assert_eq!(
            summary,
            [
                ("edit.txt", FileKind::Modified, Some(1), Some(0)),
                ("gone.txt", FileKind::Deleted, Some(0), Some(1)),
                ("new.txt", FileKind::Added, Some(3), Some(0)),
            ]
        );
        assert_eq!(run_in(&wt, &["diff", "--cached", "--name-only"]), "app/new.txt\n", "the worktree's index is untouched");
        assert_eq!(blob::file_at(&git, &wt.join("app"), &base, "edit.txt").unwrap().as_deref(), Some("one\n"));
        assert_eq!(blob::file_at(&git, &wt.join("app"), &base, "new.txt").unwrap(), None);
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
