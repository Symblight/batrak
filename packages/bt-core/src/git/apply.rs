//! Bringing a worktree's work back to the main checkout: as a patch ("Apply Locally") or by
//! checking its branch out there ("Check Out Branch").

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::exec::{self, Mode, Options};
use super::lock::with_mutation;
use super::line_counts::parse_numstat;
use super::status::{FileKind, FileStatus};
use super::temp_file::TempFile;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "outcome", content = "conflicts", rename_all = "lowercase")]
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
/// Without `keep_objects` what `add -A` writes goes to a scratch folder too: only looking at the work
/// must not grow the repository. `mode` is the caller's: a refresh nobody asked for is `Background`, what
/// the user waits for gets `Hooks`' long timeout for the clean filters (LFS) `add -A` runs over every changed file.
fn with_snapshot<T>(
    git: &Path,
    worktree: &Path,
    keep_objects: bool,
    mode: Mode,
    cancel: Option<&AtomicBool>,
    f: impl FnOnce(&dyn Fn(&[&dyn AsRef<OsStr>]) -> Result<Vec<u8>, String>) -> Result<T, String>,
) -> Result<T, String> {
    let index = TempFile::new("index");
    let git_path = |name: &'static str| -> Result<PathBuf, String> {
        let out = exec::run(git, worktree, &exec::args(&[&"rev-parse", &"--path-format=absolute", &"--git-path", &name]), Mode::Background)?;
        Ok(PathBuf::from(String::from_utf8_lossy(&out).trim()))
    };
    let seeded = std::fs::copy(git_path("index")?, &index.path).is_ok();
    let scratch_objects = TempFile::new("objects");
    let alternates = alternate_entry(&git_path("objects")?);
    let mut env: Vec<(&str, &OsStr)> = vec![("GIT_INDEX_FILE", index.path.as_os_str())];
    if !keep_objects {
        std::fs::create_dir(&scratch_objects.path).map_err(|e| format!("cannot make a scratch folder: {e}"))?;
        env.push(("GIT_OBJECT_DIRECTORY", scratch_objects.path.as_os_str()));
        env.push(("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates.as_os_str()));
    }
    let opts = Options { env: &env, cancel, ..Default::default() };
    let run = |args: &[&dyn AsRef<OsStr>]| -> Result<Vec<u8>, String> {
        let out = exec::run_with(git, worktree, &exec::args(args), mode, &opts)?;
        if out.success() { Ok(out.stdout) } else { Err(exec::failure_message(&out)) }
    };
    if !seeded {
        run(&[&"read-tree", &"HEAD"])?;
    }
    run(&[&"add", &"-A"])?;
    f(&run)
}

/// `path` as the one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`, a list split on `:` (`;` on Windows)
/// where an entry starting with a double quote is taken as C-quoted.
fn alternate_entry(path: &Path) -> std::ffi::OsString {
    match path.to_str() {
        Some(text) if text.contains([':', ';', '"']) => format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"")).into(),
        _ => path.into(),
    }
}

/// Commits the worktree's uncommitted and untracked work (ignored files aren't) onto `branch`,
/// which must be the one it has checked out, so the work outlives the worktree. Built in a scratch
/// index, with no hooks; the branch moves only if no one moved it meanwhile. Without a git identity
/// the commit is Batrak's. `None` when there's nothing uncommitted.
pub fn snapshot_commit(git: &Path, worktree: &Path, branch: &str, message: &str) -> Result<Option<String>, String> {
    let text = |out: Vec<u8>| String::from_utf8_lossy(&out).trim().to_owned();
    let current = exec::run(git, worktree, &exec::args(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]), Mode::Background);
    if current.map(text).ok().as_deref() != Some(branch) {
        return Err(format!("{}: not on branch {branch}", worktree.display()));
    }
    with_mutation(git, worktree, || {
        with_snapshot(git, worktree, true, Mode::Hooks, None, |run| {
            let tree = text(run(&[&"write-tree"])?);
            let head = text(run(&[&"rev-parse", &"--verify", &"HEAD^{commit}"])?);
            if tree == text(run(&[&"rev-parse", &"HEAD^{tree}"])?) {
                return Ok(None);
            }
            let has_identity = exec::run_with(git, worktree, &exec::args(&[&"var", &"GIT_COMMITTER_IDENT"]), Mode::Background, &Options::default())?.success();
            let batrak = OsStr::new("Batrak");
            let email = OsStr::new("batrak@localhost");
            let identity: [(&str, &OsStr); 4] =
                [("GIT_AUTHOR_NAME", batrak), ("GIT_AUTHOR_EMAIL", email), ("GIT_COMMITTER_NAME", batrak), ("GIT_COMMITTER_EMAIL", email)];
            let opts = Options { env: if has_identity { &[] } else { &identity }, ..Default::default() };
            let out = exec::run_with(git, worktree, &exec::args(&[&"commit-tree", &tree, &"-p", &head, &"-m", &message]), Mode::Local, &opts)?;
            if !out.success() {
                return Err(exec::failure_message(&out));
            }
            let sha = text(out.stdout);
            run(&[&"update-ref", &format!("refs/heads/{branch}"), &sha, &head])?;
            Ok(Some(sha))
        })
    })
}

/// Patch from `base` to the worktree's current files, uncommitted and untracked ones included
/// (ignored files are not). The worktree's own index is untouched. The user's diff settings stay out
/// of it: `git apply` takes only a plain patch with `a/` and `b/` prefixes.
pub fn changes_since(git: &Path, worktree: &Path, base: &str) -> Result<Vec<u8>, String> {
    with_snapshot(git, worktree, false, Mode::Hooks, None, |run| {
        run(&[
            &"diff",
            &"--cached",
            &"--binary",
            &"--no-ext-diff",
            &"--no-textconv",
            &"--no-color",
            &"--no-relative",
            &"--submodule=short",
            &"--src-prefix=a/",
            &"--dst-prefix=b/",
            &base,
        ])
    })
}

/// Files under `dir` (a worktree or a folder in one; paths relative to it) that differ from
/// `base`: its commits and uncommitted work together, with line counts. Renames show as a deletion
/// and an addition. Sorted by path. A refresh: once `cancel` is set git stops (`exec::CANCELLED`).
pub fn changed_since(git: &Path, dir: &Path, base: &str, cancel: &AtomicBool) -> Result<Vec<FileStatus>, String> {
    with_snapshot(git, dir, false, Mode::Background, Some(cancel), |run| {
        let diff = |format: &'static str| run(&[&"diff", &"--cached", &format, &"-z", &"--relative", &"--no-renames", &base]);
        let names = diff("--name-status")?;
        let counts = parse_numstat(&String::from_utf8_lossy(&diff("--numstat")?));
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
            exec::run_with(git, target, &exec::args(&args), Mode::Hooks, &opts)
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
        exec::run(git, worktree, &exec::args(&[&"switch", &"--detach"]), Mode::Hooks)?;
        if let Err(err) = exec::run(git, target, &exec::args(&[&"switch", &branch]), Mode::Hooks) {
            exec::run(git, worktree, &exec::args(&[&"switch", &branch]), Mode::Hooks)
                .map_err(|undo| format!("{err}; restoring the worktree's branch also failed: {undo}"))?;
            return Err(err);
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::FileKind;
    use crate::git::test_repo::{git_bin, run_in, TestRepo};
    use crate::git::{blob, worktree};

    #[test]
    fn applies_uncommitted_and_untracked_work_unstaged() {
        let mut repo = TestRepo::with_commit("apply");
        let wt = repo.worktree("apply-wt", "batrak/apply");
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
    fn looking_at_a_worktrees_changes_leaves_no_objects_in_the_repository() {
        let mut repo = TestRepo::with_commit("no-objects");
        let wt = repo.worktree("no-objects-wt", "batrak/no-objects");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        std::fs::write(wt.join("new.txt"), "new\n").unwrap();
        let before = repo.git(&["count-objects"]);

        assert_eq!(changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap().len(), 2);
        assert!(!changes_since(&git_bin(), &wt, &base).unwrap().is_empty());

        assert_eq!(repo.git(&["count-objects"]), before);
    }

    #[test]
    fn the_users_diff_settings_leave_the_applied_work_alone() {
        for (key, value) in [
            ("diff.noprefix", "true"),
            ("diff.mnemonicPrefix", "true"),
            ("color.ui", "always"),
            ("diff.external", "echo external"),
            ("diff.relative", "true"),
            ("diff.up.textconv", "sed s/t/T/"),
        ] {
            let mut repo = TestRepo::with_commit("apply-config");
            repo.write("pkg/a.txt", "one\n");
            repo.git(&["add", "pkg/a.txt"]);
            repo.git(&["commit", "-qm", "pkg"]);
            let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
            let wt = repo.worktree("apply-config-wt", "batrak/config");
            std::fs::write(wt.join("pkg/a.txt"), "two\n").unwrap();
            repo.write(".git/info/attributes", "*.txt diff=up\n");
            repo.git(&["config", key, value]);

            // From a folder of each: the project's folder inside its repository.
            assert_eq!(apply_locally(&git_bin(), &wt.join("pkg"), &base, &repo.path.join("pkg")).unwrap(), ApplyOutcome::Clean, "{key}");
            assert_eq!(std::fs::read_to_string(repo.path.join("pkg/a.txt")).unwrap(), "two\n", "{key}");
        }
    }

    #[test]
    fn the_users_submodule_format_stays_out_of_the_patch() {
        let mut repo = TestRepo::with_commit("apply-submodule");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let wt = repo.worktree("apply-submodule-wt", "batrak/submodule");
        let sub = wt.join("sub");
        std::fs::create_dir(&sub).unwrap();
        run_in(&sub, &["init", "-q", "-b", "main"]);
        run_in(&sub, &["commit", "-q", "--allow-empty", "-m", "sub"]);
        repo.git(&["config", "diff.submodule", "log"]);

        let patch = changes_since(&git_bin(), &wt, &base).unwrap();
        assert!(String::from_utf8_lossy(&patch).contains("Subproject commit"), "{}", String::from_utf8_lossy(&patch));
    }

    #[cfg(unix)]
    #[test]
    fn a_colon_in_the_repositorys_path_is_only_a_colon() {
        let mut repo = TestRepo::with_commit("co:lon");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let wt = repo.worktree("colon-wt", "batrak/colon");
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();

        let files = changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["README.md"]);
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
        let wt = repo.worktree("since-wt", "batrak/since");
        std::fs::write(wt.join("app/edit.txt"), "one\ntwo\n").unwrap();
        run_in(&wt, &["commit", "-qam", "agent"]);
        std::fs::remove_file(wt.join("app/gone.txt")).unwrap();
        std::fs::write(wt.join("app/new.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(wt.join("outside.txt"), "not the project's").unwrap();
        run_in(&wt, &["add", "app/new.txt"]);
        let git = git_bin();

        let files = changed_since(&git, &wt.join("app"), &base, &AtomicBool::new(false)).unwrap();
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
    fn a_snapshot_commits_uncommitted_and_untracked_work_onto_the_branch() {
        let mut repo = TestRepo::with_commit("snapshot");
        let wt = repo.worktree("snapshot-wt", "batrak/snap");
        let git = git_bin();
        assert_eq!(snapshot_commit(&git, &wt, "batrak/snap", "Work in progress").unwrap(), None, "nothing to keep");

        let before = run_in(&wt, &["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "edited\n").unwrap();
        std::fs::write(wt.join("new.txt"), "untracked\n").unwrap();
        let sha = snapshot_commit(&git, &wt, "batrak/snap", "Work in progress").unwrap().unwrap();
        assert_eq!(repo.git(&["rev-parse", "batrak/snap"]).trim(), sha);
        assert_eq!(repo.git(&["rev-parse", "batrak/snap^"]).trim(), before);
        assert_eq!(repo.git(&["show", "batrak/snap:new.txt"]), "untracked\n");
        assert_eq!(repo.git(&["show", "batrak/snap:README.md"]), "edited\n");
        assert_eq!(repo.git(&["log", "-1", "--format=%s", "batrak/snap"]).trim(), "Work in progress");
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main", "the checkout stays");
    }

    #[test]
    fn nothing_to_apply() {
        let mut repo = TestRepo::with_commit("apply-empty");
        let wt = repo.worktree("apply-empty-wt", "batrak/empty");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        assert_eq!(apply_locally(&git_bin(), &wt, &base, &repo.path).unwrap(), ApplyOutcome::Empty);
    }

    #[test]
    fn diverged_target_gets_conflict_markers() {
        let mut repo = TestRepo::with_commit("apply-conflict");
        let wt = repo.worktree("apply-conflict-wt", "batrak/conflict");
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
        let wt = repo.worktree("checkout-wt", "batrak/co");
        std::fs::write(wt.join("x.txt"), "x").unwrap();
        run_in(&wt, &["add", "."]);
        run_in(&wt, &["commit", "-qm", "agent"]);
        let git = git_bin();

        check_out_branch(&git, &wt, "batrak/co", &repo.path).unwrap();
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "batrak/co");
        assert!(repo.path.join("x.txt").exists());
        let wt_entry = worktree::list(&git, &repo.path).unwrap().into_iter().find(|e| e.path == wt).unwrap();
        assert_eq!(wt_entry.branch, None, "worktree detached");
    }

    #[test]
    fn failed_checkout_gives_the_worktree_its_branch_back() {
        let mut repo = TestRepo::with_commit("checkout-fail");
        let wt = repo.worktree("checkout-fail-wt", "batrak/back");
        std::fs::write(wt.join("README.md"), "agent\n").unwrap();
        run_in(&wt, &["commit", "-qam", "agent"]);
        // A local edit the switch would overwrite.
        repo.write("README.md", "unsaved user work\n");

        assert!(check_out_branch(&git_bin(), &wt, "batrak/back", &repo.path).is_err());
        assert_eq!(run_in(&wt, &["branch", "--show-current"]).trim(), "batrak/back");
        assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    }

    #[cfg(unix)]
    #[test]
    fn listing_a_worktrees_changes_doesnt_run_the_repositorys_fsmonitor_hook() {
        use std::os::unix::fs::PermissionsExt;
        let mut repo = TestRepo::with_commit("list-fsmonitor");
        let wt = repo.worktree("list-fsmonitor-wt", "batrak/list-fsmonitor");
        let base = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        std::fs::write(wt.join("README.md"), "agent edit\n").unwrap();
        let dir = crate::git::test_repo::temp_dir("list-fsmonitor-hook");
        let (hook, ran) = (dir.join("hook"), dir.join("ran"));
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ran.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);

        assert_eq!(changed_since(&git_bin(), &wt, &base, &AtomicBool::new(false)).unwrap().len(), 1);

        assert!(!ran.exists(), "the hook ran on a refresh");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn what_a_look_at_the_work_writes_only_its_owner_can_read() {
        use std::os::unix::fs::PermissionsExt;
        let mut repo = TestRepo::with_commit("private");
        let wt = repo.worktree("private-wt", "batrak/private");
        std::fs::write(wt.join("README.md"), "a secret\n").unwrap();

        let private = with_snapshot(&git_bin(), &wt, false, Mode::Background, None, |run| {
            let objects = run(&[&"rev-parse", &"--git-path", &"objects"])?;
            let objects = PathBuf::from(String::from_utf8_lossy(&objects).trim());
            let private = objects.parent().ok_or("no parent")?.to_owned();
            let mode = std::fs::metadata(&private).map_err(|e| e.to_string())?.permissions().mode();
            Ok((private, mode))
        })
        .unwrap();

        // macOS's own temp folder is 0700 too: the parent must be a folder of its own.
        assert_ne!(dunce::canonicalize(&private.0).ok(), dunce::canonicalize(std::env::temp_dir()).ok());
        assert_eq!(private.1 & 0o777, 0o700);
    }
}
