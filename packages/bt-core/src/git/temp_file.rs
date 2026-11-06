//! Temporary paths for git to read or write.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
/// Names tried before giving up; each is taken only if something else sits there.
const NAME_ATTEMPTS: u64 = 64;

/// A path for a file or folder git reads or writes (a temporary index, a commit message, scratch
/// objects), not yet created, inside a new folder of its own in the temp directory. The temp directory
/// may be shared with other users: the folder is created exclusively, so nothing planted is ever used,
/// and only its owner can enter it (0700 on Unix), whatever mode the path then gets. Dropping removes
/// the folder with all that's in it. Without such a folder, the first write to the path fails.
pub struct TempFile {
    pub path: PathBuf,
    dir: PathBuf,
}

impl TempFile {
    pub fn new(kind: &str) -> TempFile {
        TempFile::new_in(&std::env::temp_dir(), kind, &NEXT)
    }

    fn new_in(base: &Path, kind: &str, next: &AtomicU64) -> TempFile {
        let mut failure = None;
        for _ in 0..NAME_ATTEMPTS {
            let dir = base.join(format!("batrak-{kind}-{}-{}", std::process::id(), next.fetch_add(1, Ordering::Relaxed)));
            match private_dir(&dir) {
                Ok(()) => return TempFile { path: dir.join(kind), dir },
                Err(e) => failure = Some(e),
            }
        }
        tracing::warn!("cannot make a private temp folder in {}: {failure:?}", base.display());
        // Not a folder name that is merely free: someone who planted all the names above could plant
        // that one too, and be handed the contents. A NUL fails every file call and every git spawn.
        let dir = base.join("batrak-no-private-folder\0");
        TempFile { path: dir.join(kind), dir }
    }
}

fn private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    std::fs::create_dir(path)
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::temp_dir;
    use std::fs;

    fn taken_name(base: &Path, kind: &str, n: u64) -> PathBuf {
        base.join(format!("batrak-{kind}-{}-{n}", std::process::id()))
    }

    #[cfg(unix)]
    #[test]
    fn only_its_owner_can_enter_its_folder_and_the_path_is_left_for_the_caller_to_create() {
        use std::os::unix::fs::PermissionsExt;
        // Its own base: macOS's temp folder is 0700 already, which would prove nothing.
        let base = temp_dir("temp-file-private");
        let index = base.join("source-index");
        fs::write(&index, "names and hashes").unwrap();
        fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap();

        let temp = TempFile::new_in(&base, "index", &AtomicU64::new(0));

        let folder = temp.path.parent().unwrap();
        assert_eq!(fs::metadata(folder).unwrap().permissions().mode() & 0o777, 0o700);
        assert!(!temp.path.exists());
        fs::copy(&index, &temp.path).unwrap();
        assert_eq!(fs::read_to_string(&temp.path).unwrap(), "names and hashes");
        drop(temp);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_file_or_a_folder_at_the_path_goes_with_its_private_folder() {
        let file = TempFile::new("commit-msg");
        let folder = TempFile::new("objects");
        fs::write(&file.path, "message").unwrap();
        fs::create_dir(&folder.path).unwrap();
        fs::write(folder.path.join("object"), "blob").unwrap();
        let parents = [file.path.parent().unwrap().to_owned(), folder.path.parent().unwrap().to_owned()];

        drop(file);
        drop(folder);

        for parent in parents {
            assert!(!parent.exists(), "{} is still there", parent.display());
        }
    }

    #[test]
    fn two_of_the_same_kind_get_different_folders() {
        let (one, two) = (TempFile::new("index"), TempFile::new("index"));
        assert_ne!(one.path.parent(), two.path.parent());
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_file_or_symlink_is_never_used() {
        let base = temp_dir("temp-file-planted");
        let victim = base.join("victim");
        fs::write(&victim, "untouched").unwrap();
        std::os::unix::fs::symlink(&victim, taken_name(&base, "index", 0)).unwrap();
        fs::write(taken_name(&base, "index", 1), "planted").unwrap();

        let temp = TempFile::new_in(&base, "index", &AtomicU64::new(0));
        fs::write(&temp.path, "the index").unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched");
        assert_eq!(fs::read_to_string(taken_name(&base, "index", 1)).unwrap(), "planted");
        assert_eq!(fs::read_to_string(&temp.path).unwrap(), "the index");
        drop(temp);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn with_every_name_taken_the_first_write_fails_and_nothing_lands_in_a_planted_folder() {
        let base = temp_dir("temp-file-taken");
        // One more than the attempts: the next name after them is planted too.
        let planted: Vec<PathBuf> = (0..=NAME_ATTEMPTS).map(|n| taken_name(&base, "index", n)).collect();
        for folder in &planted {
            fs::create_dir(folder).unwrap();
        }

        let temp = TempFile::new_in(&base, "index", &AtomicU64::new(0));
        assert!(fs::write(&temp.path, "the index").is_err());
        drop(temp);

        for folder in &planted {
            assert_eq!(fs::read_dir(folder).map(|entries| entries.count()).ok(), Some(0), "{}", folder.display());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn with_no_temp_folder_the_first_write_fails() {
        let base = temp_dir("temp-file-missing");

        let temp = TempFile::new_in(&base.join("missing"), "index", &AtomicU64::new(0));

        assert!(fs::write(&temp.path, "the index").is_err());
        drop(temp);
        fs::remove_dir_all(base).unwrap();
    }
}
