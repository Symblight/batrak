//! File contents at a revision, for the editor's diff baseline.

use std::path::Path;

use super::exec::{self, Mode, Options};

/// Larger committed files get no diff: the editor would compute it slowly anyway.
const MAX_BLOB: usize = 5 * 1024 * 1024;

/// Text of `rel` (relative to `root`) at HEAD; `None` when it isn't in HEAD (new file, no commits,
/// not a repository). Fails, saying why, when it's there but can't be diffed as text: binary, over
/// `MAX_BLOB`, not UTF-8, or stored in Git LFS (the blob is a pointer, not the file).
pub fn file_at_head(git: &Path, root: &Path, rel: &str) -> Result<Option<String>, String> {
    file_at(git, root, "HEAD", rel)
}

/// [`file_at_head`] at the commit `rev`.
pub fn file_at(git: &Path, root: &Path, rev: &str, rel: &str) -> Result<Option<String>, String> {
    // `<rev>:./path` resolves against the working directory, so a root in a subdirectory of
    // its repository needs no prefix.
    let spec = format!("{rev}:./{rel}");
    let opts = Options { max_output: Some(MAX_BLOB), ..Default::default() };
    let out = match exec::run_with(git, root, &exec::args(&[&"cat-file", &"blob", &spec]), Mode::Background, &opts) {
        Ok(out) => out,
        Err(err) if exec::is_too_large(&err) => return Err(format!("{rel}: too large to show a diff")),
        Err(err) => return Err(err),
    };
    if !out.success() {
        return Ok(None);
    }
    if out.stdout.contains(&0) {
        return Err(format!("{rel}: binary, no diff to show"));
    }
    if out.stdout.starts_with(b"version https://git-lfs.github.com/spec/") {
        return Err(format!("{rel}: stored in Git LFS, no diff to show"));
    }
    String::from_utf8(out.stdout).map(Some).map_err(|_| format!("{rel}: not UTF-8, no diff to show"))
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
        assert!(file_at_head(&git, &repo.path, "bin.dat").unwrap_err().contains("binary"));

        let empty = TestRepo::new("blob-empty");
        empty.write("a.txt", "a");
        assert_eq!(file_at_head(&git, &empty.path, "a.txt").unwrap(), None);

        repo.write("big.txt", &"x".repeat(MAX_BLOB + 1));
        repo.write("pointer.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 9\n");
        repo.write("latin.txt", "");
        std::fs::write(repo.path.join("latin.txt"), b"caf\xe9\n").unwrap();
        repo.git(&["add", "big.txt", "pointer.bin", "latin.txt"]);
        repo.git(&["commit", "-qm", "more"]);
        for (path, why) in [("big.txt", "too large"), ("pointer.bin", "LFS"), ("latin.txt", "UTF-8")] {
            let err = file_at_head(&git, &repo.path, path).unwrap_err();
            assert!(err.contains(path) && err.contains(why), "{err}");
        }

        let plain = temp_dir("blob-plain");
        assert_eq!(file_at_head(&git, &plain, "a.txt").unwrap(), None);
        std::fs::remove_dir_all(plain).unwrap();
    }
}
