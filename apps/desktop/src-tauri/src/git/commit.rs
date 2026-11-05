//! Committing picked files from the Changes pane.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::exec::{self, Mode, Options, TempFile};
use super::lock::with_mutation;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    /// Abbreviated hash of the new commit.
    pub sha: String,
    /// First line of its message.
    pub summary: String,
}

/// Lines of a failed commit's output kept for the error: a hook's tail says why, its head is noise.
const ERROR_LINES: usize = 20;

/// Commits the working-tree contents of `paths` (relative to `root`, already checked), whatever is
/// staged: other staged files stay staged and out of the commit. Untracked files among `paths` are
/// added first, and unstaged again if the commit fails. With `amend` the last commit is replaced;
/// with no `paths` only its message changes. While a merge, cherry-pick or revert is in progress,
/// git allows no partial commit: `paths` are staged and the whole index is committed, as concluding
/// it requires. The user's hooks run.
pub fn commit(git: &Path, root: &Path, paths: &[String], message: &str, amend: bool) -> Result<Committed, String> {
    if message.trim().is_empty() {
        return Err("the commit message is empty".to_owned());
    }
    if paths.is_empty() && !amend {
        return Err("no files picked for the commit".to_owned());
    }
    // Paths go through stdin, NUL-separated: no command-line length limit (32K chars on Windows).
    let list: Vec<u8> = paths.iter().flat_map(|p| p.bytes().chain([0])).collect();
    let message_file = TempFile::new("commit-msg");
    fs::write(&message_file.path, message).map_err(|e| format!("cannot write the commit message: {e}"))?;
    let message_arg = format!("--file={}", message_file.path.display());

    with_mutation(git, root, || {
        let run = |args: &[&dyn AsRef<OsStr>], mode: Mode, input: Option<&[u8]>| {
            let out = exec::run_with(git, root, &exec::args(args), mode, &Options { input, ..Default::default() })?;
            if out.success() { Ok(out.stdout) } else { Err(exec::failure_message(&out)) }
        };
        // Staging takes the literal paths; LFS and other clean filters run, so they get the long timeout.
        let stage = |paths: &[u8]| run(&[&"update-index", &"--add", &"--remove", &"-z", &"--stdin"], Mode::Hooks, Some(paths));

        // `--literal-pathspecs` (a global option, before the command): `*.js` or `:x` is that file.
        let mut args: Vec<&dyn AsRef<OsStr>> = vec![&"--literal-pathspecs", &"commit", &"--quiet", &message_arg];
        if amend {
            args.push(&"--amend");
        }
        refuse_conflict_markers(git, root, paths)?;
        if in_progress(git, root)? {
            stage(&list)?;
            return run(&args, Mode::Hooks, None).map_err(|e| tail(&e)).and_then(|_| last_commit(git, root));
        }

        // A partial commit takes only files git knows: add the untracked ones first.
        let untracked = run(&[&"ls-files", &"-z", &"--others", &"--exclude-standard"], Mode::Local, None)?;
        let picked: HashSet<&[u8]> = paths.iter().map(|p| p.as_bytes()).collect();
        let added: Vec<u8> = untracked
            .split(|&b| b == 0)
            .filter(|p| picked.contains(p))
            .flat_map(|p| p.iter().copied().chain([0]))
            .collect();
        if !added.is_empty() {
            stage(&added)?;
        }
        // `--only`: the picked paths alone, from the working tree. With no paths (amend), the message
        // alone. Never an empty path list: git would take that as no paths and commit the whole index.
        args.push(&"--only");
        if !list.is_empty() {
            args.extend_from_slice(&[&"--pathspec-file-nul", &"--pathspec-from-file=-"]);
        }
        let input = (!list.is_empty()).then_some(list.as_slice());
        if let Err(err) = run(&args, Mode::Hooks, input) {
            if !added.is_empty() {
                // Back out of the index only; the files stay on disk, untracked as before.
                let unstage = run(&[&"update-index", &"--force-remove", &"-z", &"--stdin"], Mode::Local, Some(&added));
                if let Err(e) = unstage {
                    tracing::warn!("commit failed, and its new files stay staged: {e}");
                }
            }
            return Err(tail(&err));
        }
        last_commit(git, root)
    })
}

/// Staging a conflicted file marks it resolved, so git would commit its markers without a word.
fn refuse_conflict_markers(git: &Path, root: &Path, paths: &[String]) -> Result<(), String> {
    // `ls-files`: `diff` would run clean filters over every dirty file, on every commit.
    let out = exec::run(git, root, &exec::args(&[&"ls-files", &"-u", &"-z"]), Mode::Local)?;
    let listing = String::from_utf8_lossy(&out);
    // `<mode> <object> <stage>\t<path>`, one per stage, relative to `root`.
    let unmerged: HashSet<&str> = listing.split('\0').filter_map(|entry| Some(entry.split_once('\t')?.1)).collect();
    let unresolved: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| unmerged.contains(path))
        .filter(|path| fs::read(root.join(path)).is_ok_and(|text| text.split(|&b| b == b'\n').any(|line| line.starts_with(b"<<<<<<< "))))
        .collect();
    if unresolved.is_empty() {
        return Ok(());
    }
    Err(format!("resolve the conflict markers first: {}", unresolved.join(", ")))
}

/// A merge, cherry-pick or revert is waiting to be committed.
fn in_progress(git: &Path, root: &Path) -> Result<bool, String> {
    const MARKERS: [&str; 3] = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
    let mut args: Vec<&dyn AsRef<OsStr>> = vec![&"rev-parse", &"--path-format=absolute"];
    for marker in &MARKERS {
        args.extend_from_slice(&[&"--git-path", marker]);
    }
    let out = exec::run(git, root, &exec::args(&args), Mode::Local)?;
    Ok(String::from_utf8_lossy(&out).lines().any(|path| Path::new(path).exists()))
}

fn last_commit(git: &Path, root: &Path) -> Result<Committed, String> {
    let out = exec::run(git, root, &exec::args(&[&"log", &"-1", &"--format=%h%x00%s"]), Mode::Local)?;
    let text = String::from_utf8_lossy(&out);
    let (sha, summary) = text.trim_end().split_once('\0').unwrap_or((text.trim_end(), ""));
    Ok(Committed { sha: sha.to_owned(), summary: summary.to_owned() })
}

/// The last `ERROR_LINES` lines of a failure.
fn tail(err: &str) -> String {
    let lines: Vec<&str> = err.lines().collect();
    if lines.len() <= ERROR_LINES {
        return err.to_owned();
    }
    format!("…\n{}", lines[lines.len() - ERROR_LINES..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, run_in, TestRepo};

    /// `commit` runs git without the tests' environment: the identity and hooks come from the repository.
    fn commit_in(repo: &TestRepo, paths: &[&str], message: &str, amend: bool) -> Result<Committed, String> {
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "core.hooksPath", ".git/hooks"]);
        let paths: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
        commit(&git_bin(), &repo.path, &paths, message, amend)
    }

    #[test]
    fn commits_picked_files_only() {
        let repo = TestRepo::with_commit("commit-picked");
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "a.txt", "b.txt"]);
        repo.git(&["commit", "-qm", "two"]);
        repo.write("a.txt", "a2\n");
        repo.write("b.txt", "b2\n");
        repo.git(&["add", "b.txt"]);
        repo.write("new.txt", "n\n");
        repo.write("*.txt", "literal\n");
        std::fs::remove_file(repo.path.join("README.md")).unwrap();

        let done = commit_in(&repo, &["a.txt", "new.txt", "README.md", "*.txt"], "Pick\n\nbody", false).unwrap();
        assert_eq!(done.summary, "Pick");
        let files = repo.git(&["show", "--name-status", "--format=", "HEAD"]);
        assert_eq!(files, "A\t*.txt\nD\tREADME.md\nM\ta.txt\nA\tnew.txt\n");
        // b.txt was staged but not picked: still staged, not committed.
        assert_eq!(repo.git(&["status", "--porcelain"]), "M  b.txt\n");
        assert_eq!(repo.git(&["log", "-1", "--format=%B"]).trim_end(), "Pick\n\nbody");
    }

    #[test]
    fn commits_both_sides_of_a_rename() {
        let repo = TestRepo::with_commit("commit-rename");
        repo.git(&["mv", "README.md", "DOCS.md"]);
        commit_in(&repo, &["DOCS.md", "README.md"], "Rename", false).unwrap();
        assert_eq!(repo.git(&["show", "--name-status", "-M", "--format=", "HEAD"]), "R100\tREADME.md\tDOCS.md\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn amend_without_files_changes_the_message_only() {
        let repo = TestRepo::with_commit("commit-amend");
        repo.write("README.md", "changed\n");
        repo.git(&["add", "README.md"]);
        commit_in(&repo, &[], "Reworded", true).unwrap();
        assert_eq!(repo.git(&["log", "--format=%s"]), "Reworded\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), "M  README.md\n");
    }

    #[test]
    fn a_failing_hook_fails_the_commit() {
        let repo = TestRepo::with_commit("commit-hook");
        let hook = repo.path.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        repo.write("README.md", "changed\n");
        repo.write("new.txt", "n\n");
        let err = commit_in(&repo, &["README.md", "new.txt"], "Blocked", false).unwrap_err();
        assert!(err.contains("lint failed"), "{err}");
        assert_eq!(repo.git(&["log", "--format=%s"]), "init\n");
        // The new file was added for the commit only: untracked again.
        assert_eq!(repo.git(&["status", "--porcelain"]), " M README.md\n?? new.txt\n");
    }

    #[test]
    fn concludes_a_merge_with_the_picked_files() {
        let repo = TestRepo::with_commit("commit-merge");
        repo.write("a.txt", "a\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-qm", "a"]);
        repo.git(&["checkout", "-qb", "side"]);
        repo.write("a.txt", "side\n");
        repo.git(&["commit", "-qam", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("README.md", "main\n");
        repo.git(&["commit", "-qam", "main"]);
        let _ = run_in(&repo.path, &["merge", "--no-commit", "-q", "side"]);
        repo.write("a.txt", "resolved\n");

        commit_in(&repo, &["a.txt"], "Merge side", false).unwrap();
        assert_eq!(repo.git(&["log", "-1", "--format=%p"]).split(' ').count(), 2, "a merge commit");
        assert_eq!(repo.git(&["show", "HEAD:a.txt"]), "resolved\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }

    /// `side` and `main` both change `a.txt`, and `main` is checked out. `a.txt` holds what `main` has.
    fn two_sides_of_a_txt(repo: &TestRepo) {
        repo.write("a.txt", "a\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-qm", "a"]);
        repo.git(&["checkout", "-qb", "side"]);
        repo.write("a.txt", "side\n");
        repo.git(&["commit", "-qam", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("a.txt", "main\n");
        repo.git(&["commit", "-qam", "main"]);
    }

    #[test]
    fn refuses_a_file_that_still_has_conflict_markers() {
        // A merge in progress, and a conflict with none (a three-way apply, a stash pop).
        let merge = TestRepo::with_commit("commit-markers-merge");
        two_sides_of_a_txt(&merge);
        let _ = exec::run_with(&git_bin(), &merge.path, &exec::args(&[&"merge", &"-q", &"side"]), Mode::Local, &Options::default());
        let apply = TestRepo::with_commit("commit-markers-apply");
        two_sides_of_a_txt(&apply);
        let patch = apply.git(&["diff", "side~1", "side"]);
        let opts = Options { input: Some(patch.as_bytes()), ..Default::default() };
        let _ = exec::run_with(&git_bin(), &apply.path, &exec::args(&[&"apply", &"--3way"]), Mode::Local, &opts);

        for repo in [&merge, &apply] {
            let head = repo.git(&["rev-parse", "HEAD"]);
            let err = commit_in(repo, &["a.txt"], "Too soon", false).unwrap_err();
            assert!(err.contains("conflict markers") && err.contains("a.txt"), "{err}");
            assert_eq!(repo.git(&["rev-parse", "HEAD"]), head, "nothing committed");

            repo.write("a.txt", "resolved\n");
            commit_in(repo, &["a.txt"], "Resolved", false).unwrap();
            assert_eq!(repo.git(&["show", "HEAD:a.txt"]), "resolved\n");
        }
    }

    /// The check runs on every commit: a dirty file under a slow filter must not cost it a clean run.
    #[cfg(unix)]
    #[test]
    fn looking_for_conflicts_runs_no_filter() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_commit("commit-filter");
        let ran = repo.path.join(".git/filter-ran");
        let filter = repo.path.join(".git/clean-filter");
        std::fs::write(&filter, format!("#!/bin/sh\ntouch '{}'\ncat\n", ran.display())).unwrap();
        std::fs::set_permissions(&filter, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.write("a.dat", "a\n");
        repo.git(&["add", "a.dat"]);
        repo.git(&["commit", "-qm", "a"]);
        repo.git(&["config", "filter.slow.clean", filter.to_str().unwrap()]);
        repo.write(".git/info/attributes", "*.dat filter=slow\n");
        repo.write("a.dat", "changed\n");

        refuse_conflict_markers(&git_bin(), &repo.path, &["a.dat".to_owned()]).unwrap();

        assert!(!ran.exists());
    }

    #[test]
    fn many_paths_go_through_stdin() {
        let repo = TestRepo::with_commit("commit-many");
        let names: Vec<String> = (0..2000).map(|i| format!("a-rather-long-folder-name/file-number-{i:05}.txt")).collect();
        for name in &names {
            repo.write(name, "x\n");
        }
        let paths: Vec<&str> = names.iter().map(String::as_str).collect();
        commit_in(&repo, &paths, "Many", false).unwrap();
        assert_eq!(repo.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn refuses_an_empty_message_or_nothing_to_commit() {
        let repo = TestRepo::with_commit("commit-refuse");
        assert!(commit_in(&repo, &["README.md"], "  \n", false).is_err());
        assert!(commit_in(&repo, &[], "Nothing", false).is_err());
    }
}
