//! Lines added and removed per changed file, for a root's status and a workspace's changes.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use super::exec::{self, Mode};
use super::status::{FileKind, Status};

/// Lines added and removed, by path; `None` when unknown (binary).
pub(crate) type LineCounts = HashMap<String, (Option<u32>, Option<u32>)>;

/// Files counted by reading them, per scan: a build's output without a `.gitignore` must not read
/// thousands of files while the status lock is held.
const MAX_COUNTED_FILES: usize = 2000;
/// Untracked files larger than this get no line count.
const MAX_COUNTED_FILE: u64 = 1024 * 1024;

/// `counts` with the files the status calls renamed counted as just their edit. Those alone: `diff`
/// may pair a new file with a deleted one the status lists apart. A second read, so only when needed.
pub(super) fn with_rename_counts(git: &Path, root: &Path, status: &Status, mut counts: LineCounts) -> LineCounts {
    if status.files.iter().any(|file| file.kind == FileKind::Renamed) {
        let args = exec::args(&[&"diff", &"HEAD", &"--numstat", &"-z", &"--relative", &"-M"]);
        if let Ok(out) = exec::run(git, root, &args, Mode::Background) {
            let renames = parse_numstat(&String::from_utf8_lossy(&out));
            for file in status.files.iter().filter(|file| file.kind == FileKind::Renamed) {
                counts.extend(renames.get_key_value(&file.path).map(|(path, count)| (path.clone(), *count)));
            }
        }
    }
    counts
}

/// Fills `added`/`removed`: tracked files from `counts` (`git diff HEAD --numstat`, index and working
/// tree together), untracked files by counting their lines.
pub(super) fn add_line_counts(root: &Path, status: &mut Status, counts: &LineCounts) {
    let mut left = MAX_COUNTED_FILES;
    let mut read_count = |path: &str| {
        left = left.checked_sub(1)?;
        count_lines(&root.join(path)).map(|n| (Some(n), Some(0)))
    };
    for file in &mut status.files {
        let counted = match file.kind {
            FileKind::Untracked => read_count(&file.path),
            // No HEAD yet: everything staged is new.
            FileKind::Added if status.repo.sha.is_none() => read_count(&file.path),
            _ => counts.get(&file.path).copied(),
        };
        if let Some((added, removed)) = counted {
            (file.added, file.removed) = (added, removed);
        }
    }
}

/// `added\tremoved\tpath\0` records; a binary file has `-` for both counts. A rename has an empty
/// path, then its source and destination as records of their own; it counts under its destination.
pub(crate) fn parse_numstat(text: &str) -> LineCounts {
    let mut counts = HashMap::new();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let path = if path.is_empty() { records.nth(1).unwrap_or_default() } else { path };
        counts.insert(path.to_owned(), (added.parse().ok(), removed.parse().ok()));
    }
    counts
}

/// Lines in a text file; `None` for a directory, a symlink (it may point out of the root), a binary
/// file or one over `MAX_COUNTED_FILE`.
fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COUNTED_FILE {
        return None;
    }
    // Limited again: the file may have grown since the size above.
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(MAX_COUNTED_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_COUNTED_FILE || bytes.contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    let unterminated = usize::from(bytes.last().is_some_and(|&b| b != b'\n'));
    u32::try_from(newlines + unterminated).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::status;
    use crate::git::status::tests::{file, status_of};
    use crate::git::test_repo::{git_bin, temp_dir, TestRepo};

    /// A git that fails `diff` and runs everything else: the status can't be made to pass while the
    /// real `diff` fails.
    #[cfg(unix)]
    #[test]
    fn line_counts_that_fail_leave_the_list_without_counts() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_commit("no-counts");
        repo.write("README.md", "changed\n");
        repo.write("new.txt", "one\ntwo\n");
        let dir = temp_dir("no-counts-git");
        let fake = dir.join("git");
        let script = format!(
            "#!/bin/sh\nfor a; do [ \"$a\" = diff ] && {{ echo boom >&2; exit 128; }}; done\nexec '{}' \"$@\"\n",
            git_bin().display()
        );
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let s = status(&fake, &repo.path).unwrap().expect("a repository");
        let edited = file(&s, "README.md");
        assert_eq!((edited.kind, edited.added, edited.removed), (FileKind::Modified, None, None));
        assert_eq!(file(&s, "new.txt").added, Some(2), "an untracked file is counted without git");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_copy_and_a_deletion_git_could_pair_count_as_what_the_list_says() {
        let repo = TestRepo::with_commit("rename-apart");
        repo.write("old.txt", "one\ntwo\nthree\n");
        repo.git(&["add", "old.txt"]);
        repo.git(&["commit", "-qm", "old"]);
        repo.write("new.txt", "one\ntwo\nthree\n");
        repo.git(&["add", "new.txt"]);
        std::fs::remove_file(repo.path.join("old.txt")).unwrap();

        let s = status_of(&repo.path);
        let (new, old) = (file(&s, "new.txt"), file(&s, "old.txt"));
        assert_eq!((new.kind, new.added, new.removed), (FileKind::Added, Some(3), Some(0)));
        assert_eq!((old.kind, old.added, old.removed), (FileKind::Deleted, Some(0), Some(3)));
    }

    #[test]
    fn a_renamed_file_counts_only_its_edit() {
        let repo = TestRepo::with_commit("rename-counts");
        repo.write("old.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
        repo.git(&["add", "old.txt"]);
        repo.git(&["commit", "-qm", "old"]);
        repo.git(&["mv", "old.txt", "new.txt"]);
        repo.write("new.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
        repo.git(&["add", "new.txt"]);

        let s = status_of(&repo.path);
        let renamed = file(&s, "new.txt");
        assert_eq!((renamed.kind, renamed.added, renamed.removed), (FileKind::Renamed, Some(1), Some(0)));
    }

    #[test]
    fn a_flood_of_untracked_files_is_counted_only_so_far() {
        let repo = TestRepo::with_commit("many-untracked");
        for i in 0..MAX_COUNTED_FILES + 5 {
            repo.write(&format!("new/{i}.txt"), "a\n");
        }
        let s = status_of(&repo.path);
        assert_eq!(s.files.len(), MAX_COUNTED_FILES + 5, "all are listed");
        assert_eq!(s.files.iter().filter(|f| f.added.is_some()).count(), MAX_COUNTED_FILES);
    }

    #[cfg(unix)]
    #[test]
    fn an_untracked_symlink_isnt_followed_out_of_the_root() {
        let repo = TestRepo::with_commit("symlink-out");
        let outside = temp_dir("symlink-out-target");
        std::fs::write(outside.join("secret.txt"), "one\ntwo\n").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), repo.path.join("link.txt")).unwrap();

        let s = status_of(&repo.path);

        assert_eq!((file(&s, "link.txt").kind, file(&s, "link.txt").added), (FileKind::Untracked, None));
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn an_untracked_file_is_counted_up_to_the_limit_and_not_over_it() {
        let repo = TestRepo::with_commit("big-untracked");
        let full = "\n".repeat(MAX_COUNTED_FILE as usize);
        repo.write("full.txt", &full);
        repo.write("over.txt", &format!("{full}\n"));

        let s = status_of(&repo.path);

        assert_eq!(file(&s, "full.txt").added, Some(MAX_COUNTED_FILE as u32));
        assert_eq!(file(&s, "over.txt").added, None);
    }

    #[test]
    fn line_counts_against_head() {
        let repo = TestRepo::with_commit("lines");
        repo.write("pkg/a.txt", "one\ntwo\nthree\n");
        repo.write("gone.txt", "x\ny\n");
        repo.write("bin.dat", "a\0b");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "files"]);
        repo.write("pkg/a.txt", "one\nTWO\nthree\nfour\n");
        std::fs::remove_file(repo.path.join("gone.txt")).unwrap();
        repo.write("bin.dat", "a\0c");
        repo.write("staged.txt", "s\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("new.txt", "1\n2\n3");

        let s = status_of(&repo.path);
        let counts = |path: &str| (file(&s, path).added, file(&s, path).removed);
        assert_eq!(counts("pkg/a.txt"), (Some(2), Some(1)));
        assert_eq!(counts("gone.txt"), (Some(0), Some(2)));
        assert_eq!(counts("bin.dat"), (None, None));
        assert_eq!(counts("staged.txt"), (Some(1), Some(0)));
        assert_eq!(counts("new.txt"), (Some(3), Some(0)));

        let sub = status_of(&repo.path.join("pkg"));
        assert_eq!((file(&sub, "a.txt").added, file(&sub, "a.txt").removed), (Some(2), Some(1)));

        let fresh = TestRepo::new("lines-initial");
        fresh.write("a.txt", "a\nb\n");
        fresh.git(&["add", "."]);
        let s = status_of(&fresh.path);
        assert_eq!((file(&s, "a.txt").added, file(&s, "a.txt").removed), (Some(2), Some(0)));
    }
}
