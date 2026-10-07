import { closeWorkspace, noteFileOpened, onWorkspaceChanged, openWorkspace, pickFolder, revealPath } from './ipc.js';
import { $openingPath, $rootId, $workspace } from '../stores/workspace.js';
import { removeProjectTabs } from '../stores/editor.js';
import { $projects, addProject, removeProject } from '../stores/projects.js';

/** @typedef {import('../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../models/types.js').OpenedRoot} OpenedRoot */

/**
 * Opens project folders; the active one lives in `$workspace` (subscribe to it, or to `$rootId`, for
 * changes). Only the active project has a backend root (scan + watcher): activating another one closes
 * the current root and scans the new folder afresh, so nothing is watched for inactive projects. Emits 'fs-change' (CustomEvent<WorkspaceChanges>) when files of the current root change on disk.
 */
export class ProjectController extends EventTarget {
  /** Id of the latest `#openFolder()` call; an older one that finishes later is discarded. */
  #generation = 0;
  /** @type {{ path: string, done: Promise<void> } | null} The latest `#openFolder()` call, until it settles. */
  #pending = null;

  constructor() {
    super();
    onWorkspaceChanged((changes) => {
      if (changes.rootId !== this.rootId) return;
      this.dispatchEvent(new CustomEvent('fs-change', { detail: changes }));
    }).catch((err) => console.error('Brama: workspace events unavailable', err));
  }

  /** @returns {string | null} Canonical absolute path of the opened folder. */
  get path() {
    return $workspace.get()?.path ?? null;
  }

  /** @returns {string | null} Workspace snapshot id; `null` until the backend has the folder open. */
  get rootId() {
    return $rootId.get();
  }

  /**
   * @param {string} rel Path relative to the root.
   * @returns {string} Absolute path.
   */
  absPath(rel) {
    return rel ? `${this.path}/${rel}` : (this.path ?? '');
  }

  /**
   * @param {string} abs Absolute path inside the root.
   * @returns {string | null} Relative path, or null when outside the root.
   */
  relPath(abs) {
    if (!this.path) return null;
    const prefix = `${this.path}/`;
    return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
  }

  /** Shows the folder picker and activates the chosen folder as a project. */
  async open() {
    const picked = await pickFolder();
    if (picked === null) return;
    await this.activate(picked);
  }

  /**
   * Makes a project the active workspace, scanning and watching it from scratch.
   * @param {string} path Canonical absolute path (a project id).
   */
  async activate(path) {
    if (path === this.path && this.rootId !== null) return;
    // A second click while it is scanning waits for that scan instead of starting another.
    if (this.#pending?.path === path) return this.#pending.done;
    await this.#openFolder(path);
  }

  /** Reopens the folder persisted from the last run; forgets it if it can't be opened any more. */
  async restore() {
    const saved = $workspace.get();
    if (!saved || saved.rootId !== null) return;
    try {
      await this.#openFolder(saved.path);
    } catch (err) {
      if ($workspace.get() === saved) $workspace.set(null);
      throw err;
    }
  }

  /**
   * Opens a folder in the backend and makes it the workspace, then closes the previous root.
   * @param {string} path
   * @returns {Promise<void>}
   */
  #openFolder(path) {
    const generation = ++this.#generation;
    const done = this.#switchTo(path, generation);
    this.#setPending({ path, done });
    return done;
  }

  /** @param {{ path: string, done: Promise<void> } | null} pending Mirrored into `$openingPath`. */
  #setPending(pending) {
    this.#pending = pending;
    $openingPath.set(pending?.path ?? null);
  }

  /**
   * @param {string} path
   * @param {number} generation Of the `#openFolder()` call; the result is dropped once it is stale.
   */
  async #switchTo(path, generation) {
    /** @type {OpenedRoot} */
    let opened;
    try {
      opened = await openWorkspace(path);
    } catch (err) {
      // A newer open from this window cancels the older scan in the backend; that's not a failure.
      if (generation !== this.#generation) return;
      this.#setPending(null);
      throw err;
    }
    if (generation !== this.#generation) {
      closeWorkspace(opened.rootId).catch(() => {});
      return;
    }
    const previous = this.rootId;
    const name = opened.path.split(/[\\/]/).filter(Boolean).pop() ?? opened.path;
    addProject(opened.path, name);
    $workspace.set({ path: opened.path, name, rootId: opened.rootId });
    this.#setPending(null);
    // After the switch, so the old view never reads from a closed root.
    if (previous) closeWorkspace(previous).catch(() => {});
  }

  /**
   * Removes a project from the app; its folder on disk is untouched. When it is the active one, the next
   * project (else the previous) becomes active, or the workspace closes if none is left.
   * @param {string} id
   */
  remove(id) {
    const projects = $projects.get();
    const index = projects.findIndex((p) => p.id === id);
    const next = projects[index + 1] ?? projects[index - 1];
    const active = this.path === id;
    // An open of this project still in flight would list it again when it lands; drop it.
    if (active || this.#pending?.path === id) this.#cancelPending();
    removeProject(id);
    if (!active) {
      removeProjectTabs(id);
      return;
    }
    // Leave the removed project before forgetting its tabs, so nothing can write them back while
    // the next one is scanned.
    this.#close();
    removeProjectTabs(id);
    if (next) {
      this.#openFolder(next.path).catch((err) => console.error('Brama: opening project failed', err));
    }
  }

  /** Makes an `#openFolder()` call still in flight discard its result. */
  #cancelPending() {
    this.#generation++;
    this.#setPending(null);
  }

  /** Closes the active workspace's backend root. */
  #close() {
    if (this.rootId) closeWorkspace(this.rootId).catch(() => {});
    $workspace.set(null);
  }

  /**
   * Shows a folder in Finder / Explorer / the file manager.
   * @param {string} path Absolute.
   */
  reveal(path) {
    return revealPath(path);
  }

  /**
   * Remembers a file as recently opened, for Quick Open ranking.
   * @param {string} abs
   */
  noteOpened(abs) {
    const rel = this.relPath(abs);
    if (this.rootId && rel) noteFileOpened(this.rootId, rel).catch(() => {});
  }
}

export const projectController = new ProjectController();
