//! Throwaway repositories for tests, isolated from the user's git config.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

pub fn git_bin() -> PathBuf {
    super::binary::git().expect("tests need git").to_path_buf()
}

/// A unique, empty temporary directory, removed by `TestRepo`'s drop.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "brama-git-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dunce::canonicalize(&dir).unwrap()
}

pub struct TestRepo {
    pub path: PathBuf,
    extra: Vec<PathBuf>,
}

impl TestRepo {
    pub fn new(name: &str) -> TestRepo {
        let repo = TestRepo { path: temp_dir(name), extra: Vec::new() };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    /// A repository with one commit containing `README.md`.
    pub fn with_commit(name: &str) -> TestRepo {
        let repo = TestRepo::new(name);
        repo.write("README.md", "hello\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "init"]);
        repo
    }

    /// A repository with one commit whose `main` tracks `origin/main`, a bare repository in its own
    /// temp folder (returned, so a test can move the remote with a second clone).
    pub fn with_remote(name: &str) -> (TestRepo, PathBuf) {
        let mut repo = TestRepo::with_commit(name);
        let bare = temp_dir(&format!("{name}-origin"));
        run_in(&bare, &["init", "-q", "--bare", "-b", "main"]);
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        repo.extra.push(bare.clone());
        (repo, bare)
    }

    pub fn write(&self, rel: &str, content: &str) {
        let path = self.path.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// Runs git in the repository and returns stdout; panics on failure.
    pub fn git(&self, args: &[&str]) -> String {
        run_in(&self.path, args)
    }

    /// Adds a worktree on a new branch in a fresh directory, cleaned up with the repository.
    pub fn worktree(&mut self, name: &str, branch: &str) -> PathBuf {
        let parent = temp_dir(name);
        let path = parent.join("wt");
        self.git(&["worktree", "add", "-q", "-b", branch, path.to_str().unwrap()]);
        self.extra.push(parent);
        path
    }
}

pub fn run_in(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new(git_bin())
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
        for dir in &self.extra {
            let _ = fs::remove_dir_all(dir);
        }
    }
}
