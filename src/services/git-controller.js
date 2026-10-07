import { gitHead, gitStatus } from './ipc.js';
import { projectController } from './project-controller.js';
import { $gitChanges, $gitRepo, NO_CHANGES, NO_REPO, setCommitSelection } from '../stores/git.js';
import { $rootId } from '../stores/workspace.js';

/** @typedef {import('../models/types.js').WorkspaceChanges} WorkspaceChanges */

/** File changes come in bursts (a build, a checkout): wait for a pause before asking git. */
const REFRESH_DELAY_MS = 300;

/** Runs an async job at most once at a time; a request while it runs runs it again afterwards. */
class SerialTask {
  /** @type {() => Promise<void>} */
  #job;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  #running = false;
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
 * or a worktree has its `.git` outside the watched folder). Changed files (`$gitChanges`) need a
 * working-tree scan, so they are computed only while someone watches them — the Changes panel.
 */
export class GitController {
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** Open Changes views; files are scanned only while it's above zero. */
  #watchers = 0;
  /** Bumped when watching stops, so a scan still running then doesn't write its result. */
  #changesGeneration = 0;
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
    this.#unsubscribe = $rootId.subscribe(() => {
      // Never show the previous root's branch or files while the new one loads.
      $gitRepo.set(NO_REPO);
      setCommitSelection([]);
      this.#head.schedule(0);
      if (this.#watchers) {
        $gitChanges.set({ ...NO_CHANGES, loading: true });
        this.#changes.schedule(0);
      }
    });
    projectController.addEventListener('fs-change', this.#onFsChange);
    window.addEventListener('focus', this.#onFocus);
  }

  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    projectController.removeEventListener('fs-change', this.#onFsChange);
    window.removeEventListener('focus', this.#onFocus);
    this.#head.cancel();
    this.#changes.cancel();
  }

  /**
   * Computes the changed files now and keeps them current until the returned function is called.
   * @returns {() => void} Stops watching; calling it again does nothing.
   */
  watchChanges() {
    if (this.#watchers++ === 0) {
      $gitChanges.set({ ...NO_CHANGES, loading: true });
      this.#changes.schedule(0);
    }
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      if (--this.#watchers > 0) return;
      this.#changes.cancel();
      this.#changesGeneration++;
      $gitChanges.set(NO_CHANGES);
    };
  }

  /** Re-reads the changed files now, if anything is watching them. */
  refreshChanges() {
    if (this.#watchers) this.#changes.schedule(0);
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
    $gitChanges.set({ ...$gitChanges.get(), loading: true });
    try {
      const status = await gitStatus(rootId);
      if (!current()) return;
      $gitChanges.set({ files: status?.files ?? [], loaded: true, loading: false, error: null });
      // The scan read the branch too: no need for a separate head read.
      $gitRepo.set({ repo: status?.repo ?? null, error: null });
    } catch (err) {
      if (current()) $gitChanges.set({ files: [], loaded: true, loading: false, error: String(err) });
    }
  }
}

export const gitController = new GitController();
