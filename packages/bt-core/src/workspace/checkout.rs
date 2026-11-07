//! A workspace's worktree on disk: where it goes, checking it out, removing it. Its chats only
//! use the folder (`session::env::WorkspaceEnv`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::WorkspaceRecord;
use crate::git::exec::{self, Mode as GitMode};
use crate::git::{binary, lock, worktree};

/// What workspace branches started with before they had a marker: such a branch is its workspace's.
const LEGACY_PREFIX: &str = "batrak/";

/// Whether a worktree is checked out at `root`.
pub fn is_checked_out(root: &Path) -> bool {
    root.join(".git").exists()
}

/// Checks a workspace's worktree out on its first checkout, and again from its branch when its
/// folder was deleted; a project folder its branch lacks fails here, where the user can see it. A
/// chat's start then checks its branch (`WorkspaceEnv::prepare`). Stops early, and undoes what it
/// did, once `cancel` turns true. Blocking.
pub(super) fn check_out(w: &WorkspaceRecord, cancel: &AtomicBool) -> Result<(), String> {
    if !w.project_path.is_dir() {
        return Err(format!("{}: the project folder is gone", w.project_path.display()));
    }
    let git = binary::git()?;
    if !is_checked_out(&w.worktree_path) {
        worktree::prune(git, &w.project_path)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_owned());
        }
        let current = tip(git, w);
        // At the base it has no work to lose, and it's what a failed `worktree add -b` leaves behind.
        if current.as_ref().is_some_and(|tip| *tip != w.base_commit) && !is_own(git, w) {
            return Err(format!("Branch {} already exists with other commits, and isn't this workspace's; rename it to check the workspace out", w.branch));
        }
        let existing = current.is_some();
        let checked_out = if existing {
            worktree::attach(git, &w.project_path, &w.worktree_path, &w.branch, cancel)
        } else {
            worktree::add(git, &w.project_path, &w.worktree_path, &w.branch, &w.base_commit, cancel)
        };
        // Stopped while git checked out (git stopped, or done meanwhile): undone, the new branch too.
        if cancel.load(Ordering::SeqCst) {
            undo_checkout(git, w, existing)?;
            return Err("cancelled".to_owned());
        }
        // `-b` refuses a name that exists, so a failed checkout that leaves the branch at the base made it.
        if !existing && tip(git, w).as_deref() == Some(w.base_commit.as_str()) {
            mark_own(git, w);
        }
        checked_out?;
        tracing::info!(path = %w.worktree_path.display(), branch = %w.branch, "worktree checked out");
    }
    // On the branch in the workspace's own folder proves it's its own; this also retries a failed mark.
    if on_branch(git, &w.worktree_path, &w.branch) && !is_own(git, w) {
        mark_own(git, w);
    }
    folder_on_branch(&w.folder, &w.branch)
}

/// Switches a worktree detached by Check Out Branch back on its branch, refused while the
/// project still has it. Blocking.
pub fn back_on_branch(git: &Path, project: &Path, root: &Path, branch: &str) -> Result<(), String> {
    if on_branch(git, root, branch) {
        return Ok(());
    }
    if checked_out_elsewhere(git, project, root, branch)? {
        return Err(format!(
            "Branch {branch} is checked out in the project; switch the project to another branch to go on with this session"
        ));
    }
    worktree::switch(git, root, branch)
}

/// Whether `back_on_branch` would refuse: the project has the worktree's branch. Blocking.
pub fn held_elsewhere(project: &Path, root: &Path, branch: &str) -> Result<bool, String> {
    let git = binary::git()?;
    Ok(!on_branch(git, root, branch) && checked_out_elsewhere(git, project, root, branch)?)
}

/// The project's folder in the worktree is there (a branch may lack it).
pub fn folder_on_branch(folder: &Path, branch: &str) -> Result<(), String> {
    if folder.is_dir() {
        Ok(())
    } else {
        Err(format!("{}: the project's folder is not on branch {branch}", folder.display()))
    }
}

/// Whether the worktree has its branch checked out (not detached by Check Out Branch).
fn on_branch(git: &Path, root: &Path, branch: &str) -> bool {
    let head = exec::run(git, root, &exec::args(&[&"symbolic-ref", &"-q", &"--short", &"HEAD"]), GitMode::Background);
    head.map(|h| String::from_utf8_lossy(&h).trim().to_owned()).ok().as_deref() == Some(branch)
}

/// Whether the branch is checked out in another worktree (the project's checkout).
fn checked_out_elsewhere(git: &Path, project: &Path, root: &Path, branch: &str) -> Result<bool, String> {
    let entries = worktree::list(git, project)?;
    Ok(entries.iter().any(|e| e.branch.as_deref() == Some(branch) && e.path != root))
}

/// The branch's commit, `None` once it's gone.
fn tip(git: &Path, w: &WorkspaceRecord) -> Option<String> {
    let rev = format!("refs/heads/{}^{{commit}}", w.branch);
    let out = exec::run(git, &w.project_path, &exec::args(&[&"rev-parse", &"--verify", &"--quiet", &rev]), GitMode::Background);
    out.ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
}

/// The config key that says which workspace a branch belongs to; `branch -D` removes it with the branch.
fn owner_key(branch: &str) -> String {
    format!("branch.{branch}.batrak-workspace")
}

/// Whether the record's branch is the workspace's own: a name alone doesn't say, since a user can
/// make that branch after placement.
fn is_own(git: &Path, w: &WorkspaceRecord) -> bool {
    if w.branch.starts_with(LEGACY_PREFIX) {
        return true;
    }
    let key = owner_key(&w.branch);
    // `--default`: an unset key is an answer here, not a failed call.
    let owner = exec::run(git, &w.project_path, &exec::args(&[&"config", &"--default", &"", &"--get", &key]), GitMode::Background);
    owner.is_ok_and(|o| String::from_utf8_lossy(&o).trim() == w.id)
}

/// Marks the record's branch as its own. A failure is only logged: `check_out` tries again, and until
/// then the branch is kept on delete.
fn mark_own(git: &Path, w: &WorkspaceRecord) {
    let marked = lock::with_mutation(git, &w.project_path, || {
        exec::run(git, &w.project_path, &exec::args(&[&"config", &owner_key(&w.branch), &w.id]), GitMode::Local).map(|_| ())
    });
    if let Err(e) = marked {
        tracing::warn!(branch = %w.branch, "couldn't mark the workspace's branch: {e}");
    }
}

/// Removes a checkout just made or stopped midway (git removed its files then) and, unless the
/// branch was `existing` before, its branch. What its hooks wrote goes with it.
fn undo_checkout(git: &Path, w: &WorkspaceRecord, existing: bool) -> Result<(), String> {
    let root = &w.worktree_path;
    if is_checked_out(root) {
        // A checkout killed outright (Windows has no gentle stop) leaves it locked, which
        // `remove --force` refuses. Only a locked one: a failed git call is a user-visible warn.
        let admin = fs::read_to_string(root.join(".git")).ok();
        let locked = admin.as_deref().and_then(|a| a.trim().strip_prefix("gitdir: ")).is_some_and(|dir| Path::new(dir).join("locked").exists());
        if locked {
            worktree::unlock(git, &w.project_path, root)?;
        }
        worktree::remove_saved(git, &w.project_path, root)?;
    }
    let cleanup = if existing { worktree::BranchCleanup::Keep } else { worktree::BranchCleanup::Delete };
    let branch = tip(git, w).is_some().then_some(w.branch.as_str());
    worktree::remove(git, &w.project_path, root, branch, cleanup)
}

/// Removes the worktree. `keep_work`: uncommitted work is first committed onto the branch with
/// `message`, and the branch stays when it has commits past the base; else it's deleted. A
/// detached worktree with uncommitted work is kept (an error): its branch is the project's then.
/// A branch checked out elsewhere is never deleted (git refuses). Blocking.
pub(super) fn remove(w: &WorkspaceRecord, message: &str, keep_work: bool) -> Result<(), String> {
    let git = binary::git()?;
    let (project, root) = (&w.project_path, &w.worktree_path);
    if root.exists() && worktree::is_dirty(git, root)? {
        if !on_branch(git, root, &w.branch) {
            return Err(format!("{}: has uncommitted changes and isn't on its branch, so it was kept", root.display()));
        }
        if keep_work {
            if let Some(sha) = crate::git::apply::snapshot_commit(git, root, &w.branch, message)? {
                tracing::info!(branch = %w.branch, %sha, "saved the worktree's uncommitted work");
            }
        }
        worktree::remove_saved(git, project, root)?;
    }
    let tip = tip(git, w);
    let unused = !keep_work || tip.as_deref() == Some(w.base_commit.as_str());
    let cleanup = if unused && is_own(git, w) && !checked_out_elsewhere(git, project, root, &w.branch)? {
        worktree::BranchCleanup::Delete
    } else {
        worktree::BranchCleanup::Keep
    };
    worktree::remove(git, project, root, tip.is_some().then_some(w.branch.as_str()), cleanup)?;
    if let Some(group) = root.parent() {
        // Only when empty: the project's other worktrees keep theirs.
        let _ = fs::remove_dir(group);
    }
    tracing::info!(path = %root.display(), branch = %w.branch, ?cleanup, "worktree removed");
    Ok(())
}

/// Where a new worktree goes (`place_named`).
pub(super) struct Placed {
    /// The project's folder in the worktree.
    pub folder: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub base_commit: String,
}

/// Where a new worktree named `stem` goes: `<worktrees>/<repo>-<hash>/<stem>` on branch `<stem>`,
/// `-2`, `-3`… when the folder or the branch is taken, on disk, by a ref (`ref_taken`) or by
/// `reserved` (a worktree root and branch placed but not checked out yet). `base` (a branch or commit, `None` for the
/// project's HEAD) must name a commit. Creates nothing but the parent folder. Blocking.
pub(super) fn place_named(
    project: &Path,
    worktrees: &Path,
    stem: &str,
    base: Option<&str>,
    reserved: &dyn Fn(&Path, &str) -> bool,
) -> Result<Placed, String> {
    let git = binary::git()?;
    let run = |args: &[&dyn AsRef<std::ffi::OsStr>]| exec::run(git, project, &exec::args(args), GitMode::Background);
    let top = run(&[&"rev-parse", &"--show-toplevel"])
        .map_err(|_| format!("{}: workspaces need a git repository", project.display()))?;
    let top = exec::canonical(Path::new(String::from_utf8_lossy(&top).trim()));
    let inside = project.strip_prefix(&top).map_err(|_| format!("{}: not inside {}", project.display(), top.display()))?;
    // A branch first, then a remote branch (`origin/main`), then any name git takes (a tag, a
    // commit): git's own order puts tags first. `--end-of-options`: a base is a name, never an option.
    let names = match base {
        None => vec!["HEAD".to_owned()],
        Some(base) => vec![format!("refs/heads/{base}"), format!("refs/remotes/{base}"), base.to_owned()],
    };
    let base_commit = names
        .iter()
        .find_map(|name| run(&[&"rev-parse", &"--verify", &"--quiet", &"--end-of-options", &format!("{name}^{{commit}}")]).ok())
        .ok_or_else(|| match base {
            None => format!("{}: the repository has no commit yet", project.display()),
            Some(base) => format!("{base}: no such branch or commit"),
        })?;
    let base_commit = String::from_utf8_lossy(&base_commit).trim().to_owned();

    let name = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let group = worktrees.join(format!("{}-{:08x}", slug(&name, "project"), fnv1a(top.as_os_str().as_encoded_bytes()) as u32));
    fs::create_dir_all(&group).map_err(|e| format!("{}: {e}", group.display()))?;
    // Canonical, as `confine` compares against it.
    let group = dunce::canonicalize(&group).map_err(|e| format!("{}: {e}", group.display()))?;

    let refs = run(&[&"for-each-ref", &"--format=%(refname)", &"refs/heads", &"refs/tags", &"refs/remotes"])?;
    let refs: Vec<String> = String::from_utf8_lossy(&refs).lines().map(str::to_owned).collect();
    // The folder is named like the branch; both must be free.
    let taken = |leaf: &str| reserved(&group.join(leaf), leaf) || group.join(leaf).exists() || ref_taken(leaf, &refs);
    // Kept branches never free their numbers: the search goes on past them.
    let leaf = std::iter::once(stem.to_owned())
        .chain((2..1_000_000).map(|n| format!("{stem}-{n}")))
        .find(|leaf| !taken(leaf))
        .ok_or_else(|| format!("{stem}: every branch name is taken"))?;
    let root = group.join(&leaf);
    // `join("")` would add a trailing slash to the agent's cwd.
    let folder = if inside.as_os_str().is_empty() { root.clone() } else { root.join(inside) };
    Ok(Placed { folder, worktree_path: root, branch: leaf, base_commit })
}

/// Removes a worktree in app data that no workspace owns, unless it has uncommitted changes; its
/// branch stays. A folder that isn't a worktree goes only when empty. Blocking.
pub fn remove_orphan(path: &Path) -> Result<(), String> {
    if !is_checked_out(path) {
        return fs::remove_dir(path).map_err(|e| format!("{}: {e}", path.display()));
    }
    let git = binary::git()?;
    if worktree::is_dirty(git, path)? {
        return Err(format!("{}: a removed session's worktree with uncommitted changes; kept", path.display()));
    }
    let repo = crate::git::lock::common_dir(git, path)?;
    worktree::remove(git, &repo, path, None, worktree::BranchCleanup::Keep)?;
    tracing::info!(path = %path.display(), "removed a worktree no session owns");
    Ok(())
}

/// `text` as a branch-name part: lowercase ASCII letters and digits, runs of anything else as
/// one `-`, at most 32 characters; `fallback` when nothing is left.
pub(super) fn slug(text: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { fallback.to_owned() } else { out.to_owned() }
}

/// Whether a new branch `leaf` (a slug: lowercase, no `/`) would collide with one of `refs`.
fn ref_taken(leaf: &str, refs: &[String]) -> bool {
    let same = |part: &str| part.eq_ignore_ascii_case(leaf);
    // `HEAD`: ambiguous with it on a case-insensitive file system.
    same("head")
        || refs.iter().any(|name| {
            if let Some(remote) = name.strip_prefix("refs/remotes/") {
                // Every part, as a remote's name may hold a slash: over-matching costs only a `-2`,
                // and a branch named like a remote would make that name ambiguous.
                remote.split('/').any(same)
            } else {
                let short = name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")).unwrap_or(name);
                short.split('/').next().is_some_and(same)
            }
        })
}

/// FNV-1a: stable across builds (unlike `DefaultHasher`), so a project keeps its folder.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| (hash ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_repo::{temp_dir, TestRepo};

    /// A workspace of `repo` whose worktree is `root`, on `branch` from HEAD.
    fn workspace(repo: &TestRepo, root: &Path, branch: &str) -> WorkspaceRecord {
        WorkspaceRecord {
            id: "w".to_owned(),
            project_path: repo.path.clone(),
            name: "W".to_owned(),
            name_source: super::super::NameSource::User,
            folder: root.to_path_buf(),
            worktree_path: root.to_path_buf(),
            branch: branch.to_owned(),
            base_commit: repo.git(&["rev-parse", "HEAD"]).trim().to_owned(),
            base_branch: None,
            created_at: String::new(),
            checked_out: false,
        }
    }

    /// A checkout that finishes after Stop is undone: no worktree, no new branch.
    #[cfg(unix)]
    #[test]
    fn a_checkout_cancelled_while_it_runs_is_undone() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;
        let repo = TestRepo::with_commit("cancel-checkout");
        let hook = repo.path.join(".git/hooks/post-checkout");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\nsleep 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let home = temp_dir("cancel-checkout-home");
        let root = home.join("s");
        let w = workspace(&repo, &root, "batrak/cancel");

        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let preparing = std::thread::spawn(move || check_out(&w, &flag));
        std::thread::sleep(std::time::Duration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
        assert!(preparing.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(!root.exists());
        assert!(repo.git(&["branch", "--list", "batrak/cancel"]).is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }

    /// On Windows a cancelled checkout is killed outright: git leaves the worktree locked
    /// (`initializing`), and a plain `worktree remove --force` refuses a locked one.
    #[test]
    fn undoing_a_checkout_left_locked_removes_it_and_its_branch() {
        let repo = TestRepo::with_commit("undo-locked");
        let home = temp_dir("undo-locked-home");
        let root = home.join("s");
        let w = workspace(&repo, &root, "batrak/locked");
        let git = binary::git().unwrap();
        worktree::add(git, &repo.path, &root, "batrak/locked", &w.base_commit, &AtomicBool::new(false)).unwrap();
        repo.git(&["worktree", "lock", "--reason", "initializing", root.to_str().unwrap()]);

        undo_checkout(git, &w, false).unwrap();

        assert!(!root.exists(), "no folder");
        assert!(repo.git(&["branch", "--list", "batrak/locked"]).is_empty(), "no branch");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_worktree_is_named_after_its_stem_and_a_taken_name_takes_the_next() {
        let repo = TestRepo::with_commit("place-name");
        let worktrees = temp_dir("place-name-worktrees");
        let placed = place_named(&repo.path, &worktrees, "fix-the-login", None, &|_, _| false).unwrap();
        assert_eq!(placed.worktree_path.file_name().unwrap(), "fix-the-login");
        assert_eq!(placed.branch, "fix-the-login");

        // A folder left behind (an orphan kept for its uncommitted work) takes the next name.
        std::fs::create_dir_all(&placed.worktree_path).unwrap();
        let next = place_named(&repo.path, &worktrees, "fix-the-login", None, &|_, _| false).unwrap();
        assert_eq!(next.worktree_path.file_name().unwrap(), "fix-the-login-2");
        assert_eq!(next.branch, "fix-the-login-2");
        std::fs::remove_dir_all(worktrees).unwrap();
    }

    #[test]
    fn a_ref_takes_a_name_it_would_clash_with() {
        let refs: Vec<String> = [
            "refs/heads/main",
            "refs/heads/feature/x",
            "refs/heads/Upper",
            "refs/tags/v1",
            "refs/tags/Release/1",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/fix-login",
            "refs/remotes/origin/topic/y",
            "refs/remotes/team/b/nested",
        ]
        .map(str::to_owned)
        .into();
        for (leaf, taken) in [
            ("main", true),
            ("feature", true),
            ("upper", true),
            ("v1", true),
            ("release", true),
            ("fix-login", true),
            ("topic", true),
            ("nested", true),
            ("origin", true),
            ("team", true),
            ("head", true),
            ("free", false),
            ("mai", false),
            ("feature-2", false),
        ] {
            assert_eq!(ref_taken(leaf, &refs), taken, "{leaf}");
        }
        assert!(ref_taken("head", &[]), "ambiguous with HEAD even with no refs");
    }

    #[test]
    fn a_new_worktrees_name_skips_what_a_ref_takes() {
        let repo = TestRepo::with_commit("place-refs");
        let worktrees = temp_dir("place-refs-worktrees");
        repo.git(&["branch", "feature/x"]);
        repo.git(&["tag", "v1"]);
        let placed = |stem| place_named(&repo.path, &worktrees, stem, None, &|_, _| false).unwrap().branch;
        assert_eq!(placed("feature"), "feature-2");
        assert_eq!(placed("v1"), "v1-2");
        assert_eq!(placed("fresh"), "fresh");
        std::fs::remove_dir_all(worktrees).unwrap();
    }

    /// A commit on a new branch of `repo`, past HEAD, that nothing checked out: someone else's work.
    fn commit_on_branch(repo: &TestRepo, branch: &str) -> String {
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let head = repo.git(&["rev-parse", "HEAD"]);
        let sha = repo.git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree.trim(), "-p", head.trim(), "-m", "theirs"]);
        repo.git(&["branch", branch, sha.trim()]);
        sha.trim().to_owned()
    }

    #[test]
    fn a_branch_with_someone_elses_commits_isnt_attached_or_deleted() {
        let repo = TestRepo::with_commit("foreign-branch");
        let home = temp_dir("foreign-branch-home");
        let w = workspace(&repo, &home.join("s"), "fix-login");
        let theirs = commit_on_branch(&repo, "fix-login");

        let err = check_out(&w, &AtomicBool::new(false)).unwrap_err();
        assert!(err.contains("fix-login"), "{err}");
        assert!(!w.worktree_path.exists());

        remove(&w, "m", false).unwrap();
        assert_eq!(repo.git(&["rev-parse", "fix-login"]).trim(), theirs, "kept, Keep branch off");
        let _ = std::fs::remove_dir_all(home); // `remove` takes the empty group folder
    }

    #[test]
    fn a_workspaces_own_branch_comes_back_with_its_commits_and_goes_with_its_marker() {
        let repo = TestRepo::with_commit("own-branch");
        let home = temp_dir("own-branch-home");
        let w = workspace(&repo, &home.join("s"), "own");
        check_out(&w, &AtomicBool::new(false)).unwrap();
        crate::git::test_repo::run_in(&w.worktree_path, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
        let sha = repo.git(&["rev-parse", "own"]);

        // The folder deleted outside the app, then Recreate.
        std::fs::remove_dir_all(&w.worktree_path).unwrap();
        check_out(&w, &AtomicBool::new(false)).unwrap();
        assert_eq!(crate::git::test_repo::run_in(&w.worktree_path, &["rev-parse", "HEAD"]), sha);

        remove(&w, "m", false).unwrap();
        assert!(repo.git(&["branch", "--list", "own"]).is_empty(), "deleted");
        assert!(repo.git(&["config", "--default", "", "--get", &owner_key("own")]).trim().is_empty(), "the marker went with it");
        let _ = std::fs::remove_dir_all(home); // `remove` takes the empty group folder
    }

    #[test]
    fn a_branch_from_before_the_marker_is_still_the_workspaces() {
        let repo = TestRepo::with_commit("legacy-branch");
        let home = temp_dir("legacy-branch-home");
        let w = workspace(&repo, &home.join("s"), "batrak/old");
        commit_on_branch(&repo, "batrak/old");

        check_out(&w, &AtomicBool::new(false)).unwrap();
        remove(&w, "m", false).unwrap();

        assert!(repo.git(&["branch", "--list", "batrak/old"]).is_empty(), "deleted");
        let _ = std::fs::remove_dir_all(home); // `remove` takes the empty group folder
    }

    /// A worktree checked out with no marker (a crash before it, a failed write) gets one on the next
    /// check-out: being on the branch in the workspace's own folder proves the branch is its own.
    #[test]
    fn a_checked_out_worktree_with_no_marker_gets_one_and_comes_back_with_its_commits() {
        let repo = TestRepo::with_commit("late-marker");
        let home = temp_dir("late-marker-home");
        let w = workspace(&repo, &home.join("s"), "late");
        worktree::add(binary::git().unwrap(), &repo.path, &w.worktree_path, "late", &w.base_commit, &AtomicBool::new(false)).unwrap();

        check_out(&w, &AtomicBool::new(false)).unwrap();
        crate::git::test_repo::run_in(&w.worktree_path, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
        std::fs::remove_dir_all(&w.worktree_path).unwrap();

        check_out(&w, &AtomicBool::new(false)).unwrap();
        assert!(w.worktree_path.join(".git").exists());
        let _ = std::fs::remove_dir_all(home);
    }

    /// A check-out that fails after git made the branch: deleting the workspace takes the branch too.
    #[cfg(unix)]
    #[test]
    fn a_failed_first_checkouts_branch_goes_with_the_workspace() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_commit("failed-first");
        let hook = repo.path.join(".git/hooks/post-checkout");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let home = temp_dir("failed-first-home");
        let w = workspace(&repo, &home.join("s"), "failed");

        assert!(check_out(&w, &AtomicBool::new(false)).is_err());
        assert!(!repo.git(&["branch", "--list", "failed"]).is_empty(), "git made the branch");

        remove(&w, "m", false).unwrap();
        assert!(repo.git(&["branch", "--list", "failed"]).is_empty(), "deleted");
        let _ = std::fs::remove_dir_all(home);
    }

    /// What a failed `worktree add -b` leaves behind must not block the next try.
    #[test]
    fn an_unmarked_branch_at_the_base_commit_is_attached() {
        let repo = TestRepo::with_commit("at-base");
        let home = temp_dir("at-base-home");
        let w = workspace(&repo, &home.join("s"), "left-behind");
        repo.git(&["branch", "left-behind"]);

        check_out(&w, &AtomicBool::new(false)).unwrap();

        assert!(w.worktree_path.join(".git").exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_name_finds_a_free_number_past_a_hundred_taken() {
        let repo = TestRepo::with_commit("place-many");
        let worktrees = temp_dir("place-many-worktrees");
        // Kept branches never free their numbers: `workspace` … `workspace-150` are taken.
        let taken = |root: &Path, _: &str| {
            let leaf = root.file_name().unwrap().to_string_lossy().into_owned();
            leaf == "workspace" || leaf.strip_prefix("workspace-").and_then(|n| n.parse::<u32>().ok()).is_some_and(|n| n <= 150)
        };

        let placed = place_named(&repo.path, &worktrees, "workspace", None, &taken).unwrap();

        assert_eq!(placed.branch, "workspace-151");
        std::fs::remove_dir_all(worktrees).unwrap();
    }

    #[test]
    fn branch_names_are_slugs() {
        assert_eq!(slug("Fix the session jump!", "x"), "fix-the-session-jump");
        assert_eq!(slug("  Ünïcode — only  ", "x"), "n-code-only");
        assert_eq!(slug("…", "session"), "session");
        assert_eq!(slug(&"a".repeat(50), "x").len(), 32);
    }
}
