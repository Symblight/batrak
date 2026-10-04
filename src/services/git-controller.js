import { gitStatus } from './ipc.js';
import { projectController } from './project-controller.js';
import { $git, NO_GIT } from '../stores/git.js';
import { $rootId } from '../stores/workspace.js';

/** File changes come in bursts (a build, a checkout): wait for a pause before asking git. */
const REFRESH_DELAY_MS = 300;

/**
 * Keeps `$git` in sync with the active root's repository: refreshed when the root changes, after
 * file or repository changes (`fs-change`), and on window focus — a root inside a larger repository
 * or a worktree has its `.git` outside the watched folder, so a commit there isn't seen otherwise.
 */
export class GitController {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  #running = false;
  /** A refresh was asked for while one was running: run again when it ends. */
  #again = false;
  /** @type {(() => void) | null} */
  #unsubscribe = null;

  #onFsChange = () => this.refresh(REFRESH_DELAY_MS);
  #onFocus = () => this.refresh(0);

  /** Starts following the active root; idempotent. */
  start() {
    if (this.#unsubscribe) return;
    this.#unsubscribe = $rootId.subscribe(() => {
      // Never show the previous root's branch while the new one loads.
      $git.set(NO_GIT);
      this.refresh(0);
    });
    projectController.addEventListener('fs-change', this.#onFsChange);
    window.addEventListener('focus', this.#onFocus);
  }

  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    projectController.removeEventListener('fs-change', this.#onFsChange);
    window.removeEventListener('focus', this.#onFocus);
    clearTimeout(this.#timer);
  }

  /** @param {number} delay Ms to wait for more changes; a pending refresh is replaced. */
  refresh(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  /** One status call at a time; a result for a root that's no longer active is dropped. */
  async #run() {
    if (this.#running) {
      this.#again = true;
      return;
    }
    const rootId = $rootId.get();
    if (rootId === null) {
      $git.set(NO_GIT);
      return;
    }
    this.#running = true;
    try {
      const status = await gitStatus(rootId);
      if ($rootId.get() === rootId) $git.set(status ? { ...status, error: null } : NO_GIT);
    } catch (err) {
      if ($rootId.get() === rootId) $git.set({ ...NO_GIT, error: String(err) });
    } finally {
      this.#running = false;
      if (this.#again) {
        this.#again = false;
        this.#run();
      }
    }
  }
}

export const gitController = new GitController();
