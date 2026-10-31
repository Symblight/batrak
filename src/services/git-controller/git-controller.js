import { gitCommit, gitHead, gitStatus } from '../ipc/ipc.js';
import { projectController } from '../project-controller/project-controller.js';
import { $commitSelection, $gitChanges, $gitRepo, NO_CHANGES, NO_REPO, setCommitSelection } from '../../stores/git/git.js';
import { $rootId } from '../../stores/workspace/workspace.js';

/** @typedef {import('../../models/types/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../../models/types/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../models/types/types.js').GitCommitted} GitCommitted */

/**
 * Git state of an open root that isn't active, shown again (and checked) when it is.
 * @typedef {Object} SavedGitState
 * @property {GitRepoView} repo
 * @property {GitChangesView} changes
 * @property {number | null} version
 * @property {ReadonlySet<string>} selection Files picked for its next commit.
 */

/** File changes come in bursts (a build, a checkout): wait for a pause before asking git. */
const REFRESH_DELAY_MS = 300;

/** Runs an async job at most once at a time; a request while it runs runs it again afterwards. */
class SerialTask {
  /** @type {() => Promise<void>} */
  #job;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** The job is running. */
  #running = false;
  /** A request came in while it ran. */
  #again = false;

  /** @param {() => Promise<void>} job Handles its own errors. */
  constructor(job) {
    this.#job = job;
  }

  /** @param {number} delay Ms to wait for more requests; a pending run is replaced. */
  schedule(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  /** Drops a pending run; one in progress finishes, and its caller fences the result. */
  cancel() {
    clearTimeout(this.#timer);
    this.#again = false;
  }

  async #run() {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      await this.#job();
    } finally {
      this.#running = false;
      if (this.#again) {
        this.#again = false;
        this.#run();
      }
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
export class GitController {
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** Open Changes views; files are scanned only while it's above zero. */
  #watchers = 0;
  /** Bumped when watching stops, so a scan still running then doesn't write its result. */
  #changesGeneration = 0;
  /** @type {number | null} Backend version of the files in `$gitChanges`; `null` when it has none of this root. */
  #version = null;
  /** The next read scans even if the backend sees no change (the Refresh button). */
  #force = false;
  /** @type {string | null} Root the stores describe. */
  #rootId = null;
  /** @type {Map<string, SavedGitState>} Other open roots' state, by root id; dropped once a root closes. */
  #saved = new Map();
  #head = new SerialTask(() => this.#readHead());
  #changes = new SerialTask(() => this.#readChanges());

  #onFsChange = (/** @type {Event} */ e) => {
    const { git } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    if (git) this.#head.schedule(REFRESH_DELAY_MS);
    if (this.#watchers) this.#changes.schedule(REFRESH_DELAY_MS);
  };
  #onFocus = () => {
    this.#head.schedule(0);
    if (this.#watchers) this.#changes.schedule(0);
  };

  /** Starts following the active root; idempotent. */
  start() {
    if (this.#unsubscribe) return;
    this.#unsubscribe = $rootId.subscribe((rootId) => this.#switchRoot(rootId));
    projectController.addEventListener('fs-change', this.#onFsChange);
    window.addEventListener('focus', this.#onFocus);
  }

  /**
   * Keeps the outgoing root's state while its root stays open, and shows the incoming one's, if
   * kept, until it is checked; never the previous root's branch or files.
   * @param {string | null} rootId
   */
  #switchRoot(rootId) {
    const previous = this.#rootId;
    this.#rootId = rootId;
    if (previous !== null && previous !== rootId && projectController.isOpen(previous)) {
      this.#saved.set(previous, {
        repo: $gitRepo.get(),
        changes: { ...$gitChanges.get(), loading: false },
        version: this.#version,
        selection: $commitSelection.get(),
      });
    }
    for (const id of this.#saved.keys()) {
      if (!projectController.isOpen(id)) this.#saved.delete(id);
    }
    const saved = rootId === null ? undefined : this.#saved.get(rootId);
    if (rootId !== null) this.#saved.delete(rootId);
    // Through NO_REPO, so `$gitHead` views see a new root (old head `null`), not a HEAD move.
    $gitRepo.set(NO_REPO);
    if (saved) $gitRepo.set(saved.repo);
    setCommitSelection(saved?.selection ?? []);
    this.#version = saved?.version ?? null;
    $gitChanges.set({ ...(saved?.changes ?? NO_CHANGES), loading: this.#watchers > 0 });
    this.#head.schedule(0);
    if (this.#watchers) this.#changes.schedule(0);
  }

  /** Stops following the active root. */
  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    projectController.removeEventListener('fs-change', this.#onFsChange);
    window.removeEventListener('focus', this.#onFocus);
    this.#head.cancel();
    this.#changes.cancel();
  }

  /**
   * Brings the changed files up to date now (the last ones stay shown meanwhile) and keeps them
   * current until the returned function is called.
   * @returns {() => void} Stops watching; the files stay in `$gitChanges`. Calling it again does nothing.
   */
  watchChanges() {
    if (this.#watchers++ === 0) this.#changes.schedule(0);
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      if (--this.#watchers > 0) return;
      this.#changes.cancel();
      this.#changesGeneration++;
      const changes = $gitChanges.get();
      if (changes.loading) $gitChanges.set({ ...changes, loading: false });
    };
  }

  /** Scans the changed files again now, even if nothing seems changed, if anything is watching them. */
  refreshChanges() {
    if (!this.#watchers) return;
    this.#force = true;
    this.#changes.schedule(0);
  }

  /**
   * Commits files of the active root, then reads the branch and changed files again at once (the
   * watcher would, after its delay).
   * @param {string[]} paths Root-relative; both sides of a rename.
   * @param {string} message
   * @param {boolean} amend
   * @returns {Promise<GitCommitted>} Fails with git's message, e.g. a hook's output.
   */
  async commit(paths, message, amend) {
    const rootId = $rootId.get();
    if (rootId === null) throw new Error('No project is open');
    try {
      return await gitCommit(rootId, paths, message, amend);
    } finally {
      // A failing hook may have changed files too.
      this.#head.schedule(0);
      this.refreshChanges();
    }
  }

  async #readHead() {
    const rootId = $rootId.get();
    if (rootId === null) {
      $gitRepo.set(NO_REPO);
      return;
    }
    try {
      const repo = await gitHead(rootId);
      if ($rootId.get() === rootId) $gitRepo.set({ repo, error: null });
    } catch (err) {
      if ($rootId.get() === rootId) $gitRepo.set({ repo: null, error: String(err) });
    }
  }

  async #readChanges() {
    if (!this.#watchers) return;
    const rootId = $rootId.get();
    const generation = this.#changesGeneration;
    const current = () => $rootId.get() === rootId && this.#changesGeneration === generation;
    if (rootId === null) {
      $gitChanges.set({ ...NO_CHANGES, loaded: true });
      return;
    }
    const force = this.#force;
    this.#force = false;
    $gitChanges.set({ ...$gitChanges.get(), loading: true });
    try {
      const reply = await gitStatus(rootId, this.#version, force);
      if (!current()) return;
      const changes = $gitChanges.get();
      if (reply.unchanged && changes.loaded && !changes.error) {
        // Same files: keep the array, so views don't rebuild or re-read their diffs.
        $gitChanges.set({ ...changes, loading: false });
        return;
      }
      this.#version = reply.version;
      // The scan read the branch too: no need for a separate head read. Before the files, so views
      // hear of a HEAD move before they settle on the new status.
      $gitRepo.set({ repo: reply.status?.repo ?? null, error: null });
      $gitChanges.set({ files: reply.status?.files ?? [], loaded: true, loading: false, error: null });
    } catch (err) {
      if (!current()) return;
      this.#version = null;
      $gitChanges.set({ files: [], loaded: true, loading: false, error: String(err) });
    }
  }
}

/** The app's one `GitController`. */
export const gitController = new GitController();
