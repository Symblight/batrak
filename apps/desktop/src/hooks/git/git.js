import { $commitSelection, $gitChanges, $gitCompare, $gitRepo, NO_CHANGES, NO_COMPARE, NO_REPO, pickForCommit, setCommitSelection } from '../../stores/git/git.js';
import { $rootId } from '../../stores/workspaces/workspaces.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { projects } from '../projects/projects.js';
import { compareBranches, operationLine, remoteLine } from './branch.js';
import { changeRows, groupChanges, readDiff, renameLabel, revertPrompt, statusOf, uncommittedHint } from './changes.js';
import { SerialTask } from './serial-task.js';

/** @typedef {import('./types.js').RootChanges} RootChanges */
/** @typedef {import('./types.js').GitChangesView} GitChangesView */
/** @typedef {import('./types.js').GitRepoView} GitRepoView */
/** @typedef {import('./types.js').GitCommitted} GitCommitted */
/** @typedef {import('./types.js').GitRepoState} GitRepoState */
/** @typedef {import('./types.js').GitStatusReply} GitStatusReply */

/**
 * Git state of an open root that isn't active, shown again (and checked) when it is.
 * @typedef {Object} SavedGitState
 * @property {GitRepoView} repo
 * @property {GitChangesView} changes
 * @property {number | null} version
 * @property {ReadonlySet<string>} selection Files picked for its next commit.
 * @property {import('./types.js').GitCompareView} compare
 */

/** File changes come in bursts (a build, a checkout): wait for a pause before asking git. */
const REFRESH_DELAY_MS = 300;
/** A burst that never pauses (an agent writing for minutes) still shows now and then. */
const REFRESH_MAX_WAIT_MS = 2000;

/** Open Changes views; files are scanned only while it's above zero. */
let watchers = 0;
/** Bumped when watching stops, so a scan still running then doesn't write its result. */
let changesGeneration = 0;
/** @type {number | null} Backend version of the files in `$gitChanges`; `null` when it has none of this root. */
let version = null;
/** The next read scans even if the backend sees no change (the Refresh button). */
let force = false;
/** @type {string | null} Root the stores describe. */
let followedRoot = null;
/** @type {Map<string, SavedGitState>} Other open roots' state, by root id; dropped once a root closes. */
const saved = new Map();
/** @type {(() => void) | null} Stops the following that `start()` began. */
let following = null;
const headTask = new SerialTask(readHead, REFRESH_MAX_WAIT_MS);
const changesTask = new SerialTask(readChanges, REFRESH_MAX_WAIT_MS);
// One at a time: if each refresh stopped the last, a scan longer than the wait would never finish
// while an agent keeps writing. Showing another comparison supersedes it; a pick's scan then stops the
// running one in the backend.
const compareTask = new SerialTask(readCompare, REFRESH_MAX_WAIT_MS);

/**
 * Reads the changed files after `delay`, and the comparison if there is one.
 * @param {number} delay
 */
function scheduleChanges(delay) {
  changesTask.schedule(delay);
  if ($gitCompare.get().target !== null) compareTask.schedule(delay);
}

/**
 * Keeps the outgoing root's state while its root stays open, and shows the incoming one's, if
 * kept, until it is checked; never the previous root's branch or files.
 * @param {string | null} rootId
 */
function switchRoot(rootId) {
  const previous = followedRoot;
  followedRoot = rootId;
  if (previous !== null && previous !== rootId && projects.isOpen(previous)) {
    saved.set(previous, {
      repo: $gitRepo.get(),
      changes: { ...$gitChanges.get(), loading: false },
      version,
      selection: $commitSelection.get(),
      compare: $gitCompare.get(),
    });
  }
  for (const id of saved.keys()) {
    if (!projects.isOpen(id)) saved.delete(id);
  }
  const kept = rootId === null ? undefined : saved.get(rootId);
  if (rootId !== null) saved.delete(rootId);
  // Through NO_REPO, so `$gitHead` views see a new root (old head `null`), not a HEAD move.
  $gitRepo.set(NO_REPO);
  if (kept) $gitRepo.set(kept.repo);
  setCommitSelection(kept?.selection ?? []);
  version = kept?.version ?? null;
  $gitChanges.set({ ...(kept?.changes ?? NO_CHANGES), loading: watchers > 0 });
  compareTask.supersede();
  $gitCompare.set(kept?.compare ?? NO_COMPARE);
  headTask.schedule(0);
  if (watchers) scheduleChanges(0);
}

/**
 * Shows an answer about the root's branch, unless another root is shown by now.
 * @param {string} rootId
 * @param {GitRepoView} view
 */
function showRepo(rootId, view) {
  if ($rootId.get() === rootId) $gitRepo.set(view);
}

async function readHead() {
  const rootId = $rootId.get();
  if (rootId === null) {
    $gitRepo.set(NO_REPO);
    return;
  }
  try {
    /** @type {GitRepoState | null} */
    const repo = await ipc.invoke('git_head', { rootId });
    showRepo(rootId, { repo, error: null });
  } catch (err) {
    showRepo(rootId, { repo: null, error: String(err) });
  }
}

async function readChanges() {
  if (!watchers) return;
  const rootId = $rootId.get();
  const generation = changesGeneration;
  const current = () => $rootId.get() === rootId && changesGeneration === generation;
  if (rootId === null) {
    $gitChanges.set({ ...NO_CHANGES, loaded: true });
    return;
  }
  const scanAnyway = force;
  force = false;
  $gitChanges.set({ ...$gitChanges.get(), loading: true });
  try {
    /** @type {GitStatusReply} */
    const reply = await ipc.invoke('git_status', { rootId, since: version, force: scanAnyway });
    if (!current()) return;
    const changes = $gitChanges.get();
    if (reply.unchanged && changes.loaded && !changes.error) {
      // Same files: keep the array, so views don't rebuild or re-read their diffs.
      $gitChanges.set({ ...changes, loading: false });
      return;
    }
    version = reply.version;
    // The scan read the branch too: no need for a separate head read. Before the files, so views
    // hear of a HEAD move before they settle on the new status.
    showRepo(rootId, { repo: reply.status?.repo ?? null, error: null });
    $gitChanges.set({ files: reply.status?.files ?? [], loaded: true, loading: false, error: null });
  } catch (err) {
    if (!current()) return;
    version = null;
    $gitChanges.set({ files: [], loaded: true, loading: false, error: String(err) });
  }
}

/**
 * Asks for the comparison shown and shows the answer, unless superseded by then. Only this job writes
 * `$gitCompare` within a generation, so `view` is still what is shown.
 * @param {() => boolean} isCurrent
 */
async function readCompare(isCurrent) {
  const rootId = $rootId.get();
  const view = $gitCompare.get();
  const { target, changes } = view;
  if (rootId === null || target === null) return;
  if (!changes.loading) $gitCompare.set({ ...view, changes: { ...changes, loading: true } });
  try {
    /** @type {import('./types.js').GitComparison} */
    const { base, files } = await ipc.invoke('git_compare', { rootId, target });
    if (!isCurrent()) return;
    // Same files: keep the array, so views don't rebuild or re-read their diffs.
    const same = JSON.stringify(changes.files) === JSON.stringify(files);
    $gitCompare.set({ target, base, changes: { files: same ? changes.files : files, loaded: true, loading: false, error: null }, refreshError: null });
  } catch (err) {
    if (!isCurrent()) return;
    if (String(err).startsWith('cancelled')) {
      // Nothing to show yet: a stop for the last comparison may have reached this one. Still loading,
      // or the views would say nothing differs.
      $gitCompare.set({ ...view, changes: { ...changes, loading: !changes.loaded } });
      if (!changes.loaded) compareTask.schedule(0);
    } else if (changes.loaded && changes.error === null) {
      // A refresh: the last good list stays.
      $gitCompare.set({ ...view, changes: { ...changes, loading: false }, refreshError: String(err) });
    } else {
      $gitCompare.set({ ...view, changes: { files: [], loaded: true, loading: false, error: String(err) } });
    }
  }
}

/**
 * Git state of the active root. The branch (`$gitRepo`) is cheap and kept current while a project
 * is open: on root change, repository changes and window focus (a root inside a larger repository
 * or a worktree has its `.git` outside the watched folder). Changed files (`$gitChanges`) are kept
 * current only while someone watches them (the Changes pane or tab); when the last one stops they
 * stay in memory, and showing a view again only asks the backend whether its version is still
 * current, which costs no scan when nothing changed.
 */
export const git = Object.freeze({
  groupChanges,
  readDiff,
  revertPrompt,
  uncommittedHint,
  statusOf,
  changeRows,
  renameLabel,
  remoteLine,
  operationLine,
  compareBranches,

  /**
   * Starts following the active root; once however often it is called.
   * @returns {() => void} Stops following.
   */
  start() {
    if (following) return following;
    const onFocus = () => {
      headTask.schedule(0);
      if (watchers) scheduleChanges(0);
    };
    const stops = [
      $rootId.subscribe(switchRoot),
      projects.onFsChange(({ git: moved }) => {
        if (moved) headTask.schedule(REFRESH_DELAY_MS);
        if (watchers) scheduleChanges(REFRESH_DELAY_MS);
      }),
    ];
    window.addEventListener('focus', onFocus);
    following = () => {
      stops.forEach((stop) => stop());
      window.removeEventListener('focus', onFocus);
      headTask.cancel();
      changesTask.cancel();
      compareTask.cancel();
      following = null;
    };
    return following;
  },

  /**
   * Brings the changed files up to date now (the last ones stay shown meanwhile) and keeps them
   * current until the returned function is called.
   * @returns {() => void} Stops watching; the files stay in `$gitChanges`. Calling it again does nothing.
   */
  watchChanges() {
    if (watchers++ === 0) scheduleChanges(0);
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      if (--watchers > 0) return;
      changesTask.cancel();
      compareTask.cancel();
      changesGeneration++;
      const changes = $gitChanges.get();
      if (changes.loading) $gitChanges.set({ ...changes, loading: false });
    };
  },

  /** Scans the changed files again now, even if nothing seems changed, if anything is watching them. */
  refreshChanges() {
    if (!watchers) return;
    force = true;
    scheduleChanges(0);
  },

  /**
   * Shows what the active root has against a branch in the Changes views, or local changes again.
   * Asks at once: a scan still running stops, for this root.
   * @param {string | null} target A full short name (`main`, `origin/main`); `null` goes back.
   */
  compareTo(target) {
    const rootId = $rootId.get();
    compareTask.supersede();
    if (target === null || rootId === null) {
      $gitCompare.set(NO_COMPARE);
      if (rootId !== null) ipc.invoke('git_compare_stop', { rootId }).catch(() => {}); // only saves work
      return;
    }
    $gitCompare.set({ ...NO_COMPARE, target, changes: { ...NO_CHANGES, loading: true } });
    compareTask.run();
  },

  /**
   * A file's text at a comparison's base, the diff's baseline.
   * @param {string} rootId
   * @param {string} rev A full commit id.
   * @param {string} path Relative.
   * @returns {Promise<string | null>} `null` when it wasn't there. Fails, saying why, when it has no text to diff.
   */
  fileAtRev(rootId, rev, path) {
    return ipc.invoke('git_file_at_rev', { rootId, rev, path });
  },

  /**
   * Commits files of the active root, then reads the branch and changed files again at once (the
   * watcher would, after its delay). The user's hooks run.
   * @param {string[]} paths Root-relative; both sides of a rename. Empty with `amend` rewords the last commit.
   * @param {string} message
   * @param {boolean} amend Replace the last commit.
   * @returns {Promise<GitCommitted>} Fails with git's message, e.g. a hook's output.
   */
  async commit(paths, message, amend) {
    const rootId = $rootId.get();
    if (rootId === null) throw new Error('No project is open');
    try {
      return await ipc.invoke('git_commit', { rootId, paths, message, amend });
    } finally {
      // A failing hook may have changed files too.
      headTask.schedule(0);
      git.refreshChanges();
    }
  },

  /**
   * Makes changed files match HEAD, all or none; both sides of a rename. Their work stays in a ref.
   * @param {readonly import('./types.js').GitFileStatus[]} files
   * @returns {Promise<void>}
   */
  async revertFiles(files) {
    const rootId = $rootId.get();
    if (rootId === null) throw new Error('No project is open');
    try {
      const paths = files.flatMap((file) => (file.origPath ? [file.path, file.origPath] : [file.path]));
      await ipc.invoke('git_revert_files', { rootId, paths });
    } finally {
      git.refreshChanges();
    }
  },

  /**
   * Throwing work away, asked about first: makes the files match HEAD, then no longer picked for a commit. A failure is shown.
   * @param {readonly import('./types.js').GitFileStatus[]} files
   * @param {(options: import('../app/types.js').ConfirmOptions) => Promise<boolean>} confirm The view's dialog.
   * @returns {Promise<void>}
   */
  async revertAsking(files, confirm) {
    const [first] = files;
    if (!first || !(await confirm(revertPrompt(files)))) return;
    try {
      await git.revertFiles(files);
      pickForCommit(files.map((file) => file.path), false);
    } catch (err) {
      const what = files.length === 1 ? first.path.slice(first.path.lastIndexOf('/') + 1) : `${files.length} files`;
      app.reportError(`Couldn’t revert ${what}`, err);
    }
  },

  /**
   * Branches a workspace can be based on: local and remote-tracking ones, most recently committed
   * first, and the remote's default.
   * @param {string} rootId
   * @returns {Promise<import('./types.js').BranchList>}
   */
  branches(rootId) {
    return ipc.invoke('git_branches', { rootId });
  },

  /**
   * Fetches every remote of the root's repository, pruning deleted branches (New worktree's base menu refreshes with it).
   * @param {string} rootId
   * @returns {Promise<void>}
   */
  fetch(rootId) {
    return ipc.invoke('git_fetch', { rootId });
  },

  /**
   * A root's checked-out branch (`null` when detached or outside a repository).
   * @param {string} rootId
   * @returns {Promise<string | null>}
   */
  async branchOf(rootId) {
    /** @type {import('./types.js').GitRepoState | null} */
    const repo = await ipc.invoke('git_head', { rootId });
    return repo?.detached ? null : (repo?.branch ?? null);
  },

  /**
   * Message of the last commit, which Amend starts from.
   * @param {string} rootId
   * @returns {Promise<string | null>} `null` before the first commit.
   */
  lastCommitMessage(rootId) {
    return ipc.invoke('git_last_commit_message', { rootId });
  },

  /**
   * A file's text at HEAD, the editor's diff baseline.
   * @param {string} rootId
   * @param {string} path Relative.
   * @returns {Promise<string | null>} `null` when not committed or not in a repository. Fails, saying why, when it has no text to diff.
   */
  fileAtHead(rootId, path) {
    return ipc.invoke('git_file_at_head', { rootId, path });
  },
});
