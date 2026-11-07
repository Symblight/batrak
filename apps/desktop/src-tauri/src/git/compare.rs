//! What the checked-out work has against another branch: the files since the two parted.

use std::ffi::OsStr;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use super::blob::file_at;
use super::exec::{self, Mode, Options};
use super::status::FileStatus;
use super::workspace_changes::changed_since;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// The branch as asked for, a full short name: `main`, `origin/main`.
    pub target: String,
    /// Where HEAD and the branch parted: a full commit id, the diffs' baseline.
    pub base: String,
    /// Relative to the root, sorted by path.
    pub files: Vec<FileStatus>,
}

/// Compares the work under `root` (commits and uncommitted files) to the branch `target`, from
/// their merge base, so the branch's own later commits don't show. Changes nothing. Blocking; once
/// `cancel` is set git stops (`exec::CANCELLED`).
pub fn compare_to(git: &Path, root: &Path, target: &str, cancel: &AtomicBool) -> Result<Comparison, String> {
    let opts = Options { cancel: Some(cancel), ..Default::default() };
    // `None` for exit code 1, these commands' "no": anything else, a timeout too, is its own error.
    let answer = |args: &[&dyn AsRef<OsStr>]| -> Result<Option<String>, String> {
        let out = exec::run_with(git, root, &exec::args(args), Mode::Background, &opts)?;
        if out.success() {
            return Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()));
        }
        if out.status.code() == Some(1) { Ok(None) } else { Err(exec::failure_message(&out)) }
    };
    let missing = || format!("{target} no longer exists");
    // Only a branch's name: `main~1` would compare to another commit under that label.
    if answer(&[&"check-ref-format", &format!("refs/heads/{target}")])?.is_none() {
        return Err(missing());
    }
    // Full refs: a bare name would resolve to a tag of that name first. Git itself lists a branch
    // that a tag shadows as `heads/main`, which is why that form is looked up too.
    let mut refs = vec![format!("refs/heads/{target}"), format!("refs/remotes/{target}")];
    refs.extend(target.strip_prefix("heads/").map(|branch| format!("refs/heads/{branch}")));
    let mut tip = None;
    for name in refs {
        tip = answer(&[&"rev-parse", &"--verify", &"--quiet", &format!("{name}^{{commit}}")])?;
        if tip.is_some() {
            break;
        }
    }
    let tip = tip.ok_or_else(missing)?;
    let Some(base) = answer(&[&"merge-base", &"HEAD", &tip])? else {
        let shallow = answer(&[&"rev-parse", &"--is-shallow-repository"])?;
        return Err(if shallow.as_deref() == Some("true") {
            format!("This is a shallow clone, so its history with {target} isn't here")
        } else {
            format!("No common history with {target}")
        });
    };
    let files = changed_since(git, root, &base, cancel)?;
    Ok(Comparison { target: target.to_owned(), base, files })
}

/// Text of `rel` at the commit `rev`, a comparison's `base`; `None` when it wasn't there. Fails unless
/// `rev` is a full id of a commit that exists: `blob::file_at` answers `None` for any failure, which
/// would draw the whole file as added.
pub fn file_at_commit(git: &Path, root: &Path, rev: &str, rel: &str) -> Result<Option<String>, String> {
    let not_a_commit = || format!("{rev} isn't a commit");
    let full_id = matches!(rev.len(), 40 | 64) && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if !full_id {
        return Err(not_a_commit());
    }
    let commit = format!("{rev}^{{commit}}");
    let found = exec::run_with(git, root, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &commit]), Mode::Background, &Options::default())?;
    if !found.success() {
        return Err(not_a_commit());
    }
    file_at(git, root, rev, rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::FileKind;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    fn compare(root: &Path, target: &str) -> Result<Comparison, String> {
        compare_to(&git_bin(), root, target, &AtomicBool::new(false))
    }

    fn paths(comparison: &Comparison) -> Vec<&str> {
        comparison.files.iter().map(|file| file.path.as_str()).collect()
    }

    /// `side` left `main` at the first commit, and `main` went on: returns the repo, on `side`.
    fn repo_on_a_side_branch(name: &str) -> TestRepo {
        let repo = TestRepo::with_commit(name);
        repo.git(&["switch", "-qc", "side"]);
        repo.git(&["switch", "-q", "main"]);
        repo.write("later-on-main.txt", "main went on\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "later on main"]);
        repo.git(&["switch", "-q", "side"]);
        repo
    }

    fn commit_all(repo: &TestRepo, message: &str) {
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", message]);
    }

    #[test]
    fn lists_commits_and_uncommitted_and_untracked_work_from_the_merge_base() {
        let repo = repo_on_a_side_branch("compare-work");
        let parted = repo.git(&["merge-base", "side", "main"]).trim().to_owned();
        repo.write("committed.txt", "one\ntwo\n");
        commit_all(&repo, "on side");
        repo.write("README.md", "uncommitted edit\n");
        repo.write("untracked.txt", "new\n");

        let comparison = compare(&repo.path, "main").unwrap();

        assert_eq!(comparison.target, "main");
        assert_eq!(comparison.base, parted);
        assert_eq!(paths(&comparison), ["README.md", "committed.txt", "untracked.txt"], "not later-on-main.txt");
        let committed = &comparison.files[1];
        assert_eq!((committed.kind, committed.added, committed.removed), (FileKind::Added, Some(2), Some(0)));
    }

    #[test]
    fn nothing_different_is_an_empty_list() {
        let repo = repo_on_a_side_branch("compare-nothing");
        assert_eq!(paths(&compare(&repo.path, "main").unwrap()), Vec::<&str>::new());
    }

    #[test]
    fn a_remote_tracking_branch_can_be_the_target() {
        let (repo, _bare) = TestRepo::with_remote("compare-remote");
        repo.write("unpushed.txt", "new\n");
        commit_all(&repo, "unpushed");

        assert_eq!(paths(&compare(&repo.path, "origin/main").unwrap()), ["unpushed.txt"]);
    }

    #[test]
    fn a_root_in_a_subfolder_gets_its_own_files_relative_to_it() {
        let repo = repo_on_a_side_branch("compare-subfolder");
        repo.write("pkg/inside.txt", "new\n");
        repo.write("outside.txt", "new\n");
        commit_all(&repo, "on side");

        assert_eq!(paths(&compare(&repo.path.join("pkg"), "main").unwrap()), ["inside.txt"]);
    }

    #[test]
    fn a_branch_is_compared_even_when_a_tag_has_its_name() {
        let repo = repo_on_a_side_branch("compare-tag");
        let branch_tip = repo.git(&["rev-parse", "main"]).trim().to_owned();
        repo.write("tagged.txt", "new\n");
        commit_all(&repo, "tagged");
        repo.git(&["tag", "main", "HEAD"]);
        let parted = repo.git(&["merge-base", "side", &branch_tip]).trim().to_owned();

        let comparison = compare(&repo.path, "main").unwrap();

        assert_eq!(comparison.base, parted, "the tag is HEAD itself, which would list nothing");
        assert_eq!(paths(&comparison), ["tagged.txt"]);
    }

    #[test]
    fn a_missing_branch_says_so() {
        let repo = repo_on_a_side_branch("compare-missing");
        assert_eq!(compare(&repo.path, "gone").unwrap_err(), "gone no longer exists");
    }

    #[test]
    fn revision_syntax_is_only_a_missing_branch() {
        let repo = repo_on_a_side_branch("compare-revision");
        for target in ["main~1", "main^", "main@{0}"] {
            assert_eq!(compare(&repo.path, target).unwrap_err(), format!("{target} no longer exists"));
        }
    }

    #[test]
    fn the_name_git_lists_for_a_branch_a_tag_shadows_is_that_branch() {
        let repo = repo_on_a_side_branch("compare-listed");
        repo.git(&["tag", "main", "HEAD"]);
        let listed = crate::git::branches::branches(&git_bin(), &repo.path).unwrap();
        assert!(listed.iter().any(|name| name == "heads/main"), "{listed:?}");
        repo.write("on-side.txt", "side\n");
        commit_all(&repo, "on side");

        assert_eq!(paths(&compare(&repo.path, "heads/main").unwrap()), ["on-side.txt"]);
    }

    #[test]
    fn a_branch_with_no_shared_history_says_so() {
        let repo = repo_on_a_side_branch("compare-unrelated");
        repo.git(&["switch", "-q", "--orphan", "island"]);
        repo.write("island.txt", "alone\n");
        commit_all(&repo, "alone");

        assert_eq!(compare(&repo.path, "main").unwrap_err(), "No common history with main");
    }

    // A `file://` URL needs the path to start with `/`.
    #[cfg(unix)]
    #[test]
    fn a_shallow_clone_says_its_history_isnt_here() {
        let repo = repo_on_a_side_branch("compare-shallow-source");
        repo.write("on-side.txt", "side\n");
        commit_all(&repo, "on side");
        let clone = temp_dir("compare-shallow");
        let url = format!("file://{}", repo.path.display());
        crate::git::test_repo::run_in(&clone, &["clone", "-q", "--depth", "1", "--no-single-branch", "--branch", "side", &url, "."]);

        assert_eq!(compare(&clone, "origin/main").unwrap_err(), "This is a shallow clone, so its history with origin/main isn't here");
        std::fs::remove_dir_all(clone).unwrap();
    }

    #[test]
    fn any_other_failure_is_gits_own_message() {
        let plain = temp_dir("compare-plain");

        let err = compare(&plain, "main").unwrap_err();

        assert!(err.contains("not a git repository"), "{err}");
        std::fs::remove_dir_all(plain).unwrap();
    }

    #[test]
    fn a_cancelled_call_stops() {
        let repo = repo_on_a_side_branch("compare-cancel");
        let err = compare_to(&git_bin(), &repo.path, "main", &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err, exec::CANCELLED);
    }

    #[test]
    fn a_file_at_a_commit_is_its_text_or_nothing_when_it_wasnt_there() {
        let repo = TestRepo::with_commit("compare-file");
        let sha = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("README.md", "edited\n");
        commit_all(&repo, "a later commit, so HEAD isn't the answer");

        assert_eq!(file_at_commit(&git_bin(), &repo.path, &sha, "README.md").unwrap().as_deref(), Some("hello\n"));
        assert_eq!(file_at_commit(&git_bin(), &repo.path, &sha, "new.txt").unwrap(), None);
    }

    #[test]
    fn a_file_at_anything_but_a_full_id_of_an_existing_commit_fails() {
        let repo = TestRepo::with_commit("compare-file-rev");
        let sha = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]).trim().to_owned();
        // A branch whose name is 40 characters and not hex resolves, so only the hex check refuses it.
        let named = "z".repeat(40);
        repo.git(&["branch", &named]);
        for rev in ["HEAD", "main", "--output=x", &sha[..7], &"a".repeat(40), &"a".repeat(64), named.as_str(), &tree] {
            let err = file_at_commit(&git_bin(), &repo.path, rev, "README.md").unwrap_err();
            assert!(err.contains("isn't a commit"), "{rev}: {err}");
        }
    }

    #[test]
    fn comparing_leaves_the_repository_as_it_was() {
        let repo = repo_on_a_side_branch("compare-untouched");
        repo.write("README.md", "uncommitted edit\n");
        repo.write("untracked.txt", "new\n");
        let (objects, status) = (repo.git(&["count-objects"]), repo.git(&["status", "--porcelain"]));

        assert_eq!(compare(&repo.path, "main").unwrap().files.len(), 2);

        assert_eq!(repo.git(&["count-objects"]), objects);
        assert_eq!(repo.git(&["status", "--porcelain"]), status);
    }
}
