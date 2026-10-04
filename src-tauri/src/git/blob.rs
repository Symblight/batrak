//! File contents at a revision, for the editor's diff baseline.

use std::path::Path;

use super::exec::{self, Mode, Options};

/// Larger committed files get no baseline: the editor would diff them slowly anyway.
const MAX_BLOB: usize = 5 * 1024 * 1024;

/// Text of `rel` (relative to `root`) at HEAD; `None` when it isn't in HEAD (new file, no
/// commits, not a repository), is binary, or is over `MAX_BLOB`.
pub fn file_at_head(git: &Path, root: &Path, rel: &str) -> Result<Option<String>, String> {
    // `HEAD:./path` resolves against the working directory, so a root in a subdirectory of
    // its repository needs no prefix.
    let spec = format!("HEAD:./{rel}");
    let opts = Options { max_output: Some(MAX_BLOB), ..Default::default() };
    let out = match exec::run_with(git, root, &exec::args(&[&"cat-file", &"blob", &spec]), Mode::Background, &opts) {
        Ok(out) => out,
        Err(err) if exec::is_too_large(&err) => return Ok(None),
        Err(err) => return Err(err),
    };
    if !out.success() {
        return Ok(None);
    }
    if out.stdout.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(out.stdout).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    #[test]
    fn committed_text_and_the_cases_without_a_baseline() {
        let repo = TestRepo::with_commit("blob");
        repo.write("pkg/a b.txt", "committed\n");
        repo.write("bin.dat", "a\0b");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "files"]);
        repo.write("pkg/a b.txt", "edited\n");
        repo.write("new.txt", "new");

        let git = git_bin();
        assert_eq!(file_at_head(&git, &repo.path, "pkg/a b.txt").unwrap().as_deref(), Some("committed\n"));
        assert_eq!(file_at_head(&git, &repo.path.join("pkg"), "a b.txt").unwrap().as_deref(), Some("committed\n"));
        assert_eq!(file_at_head(&git, &repo.path, "new.txt").unwrap(), None);
        assert_eq!(file_at_head(&git, &repo.path, "bin.dat").unwrap(), None);

        let empty = TestRepo::new("blob-empty");
        empty.write("a.txt", "a");
        assert_eq!(file_at_head(&git, &empty.path, "a.txt").unwrap(), None);

        let plain = temp_dir("blob-plain");
        assert_eq!(file_at_head(&git, &plain, "a.txt").unwrap(), None);
        std::fs::remove_dir_all(plain).unwrap();
    }
}
