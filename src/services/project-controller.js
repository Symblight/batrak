import {
  closeWindowWorkspaces,
  closeWorkspace,
  noteFileOpened,
  onWorkspaceChanged,
  openWorkspace,
  pickFolder,
  revealPath,
} from './ipc.js';
import { $openingPath, $rootId, $workspace } from '../stores/workspace.js';
import { removeProjectTabs } from '../stores/editor.js';
import { removeProjectExpandedFolders } from '../stores/file-tree.js';
import { $projects, addProject, removeProject } from '../stores/projects.js';
import { reportError } from './notices.js';

/** @typedef {import('../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../models/types.js').OpenedRoot} OpenedRoot */

/**
 * Projects whose backend root (snapshot + watcher) stays open, the active one included. Switching to
 * one of them needs no scan: its watcher kept the snapshot current.
 */
const KEEP_OPEN = 3;

/**
 * Opens project folders; the active one lives in `$workspace` (subscribe to it, or to `$rootId`, for
 * changes). The last `KEEP_OPEN` active projects keep their backend root (scan + watcher), so
 * switching back to one is instant; an older one is closed and scanned afresh when activated again.
 * Emits 'fs-change' (CustomEvent<WorkspaceChanges>) when files of the active root change on disk;
 * the other open roots' changes only reach their snapshots and git caches.
 */
export class ProjectController extends EventTarget {
  /** Id of the latest `#openFolder()` call; an older one that finishes later is discarded. */
  #generation = 0;
  /**
   * @type {Map<string, { rootId: string, name: string }>} Open roots by project path, least recently
   * active first; the active project is last.
   */
  #roots = new Map();
  /** Roots this window's previous page load left open are closed before anything opens. */
  #ready = closeWindowWorkspaces().catch((err) => reportError('Closing previous projects failed', err));
  /** @type {{ path: string, done: Promise<void> } | null} The latest `#openFolder()` call, until it settles. */
  #pending = null;

  constructor() {
    super();
    onWorkspaceChanged((changes) => {
      if (changes.rootId !== this.rootId) return;
      this.dispatchEvent(new CustomEvent('fs-change', { detail: changes }));
    }).catch((err) => reportError('File watching unavailable', err));
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
   * @param {string} rootId
   * @returns {boolean} Whether a backend root is still open (active or kept for switching back).
   */
  isOpen(rootId) {
    return [...this.#roots.values()].some((root) => root.rootId === rootId);
  }

  /**
   * Makes a project the active workspace: at once when its root is still open, else by scanning it.
   * @param {string} path Canonical absolute path (a project id).
   */
  async activate(path) {
    if (path === this.path && this.rootId !== null) return;
    const open = this.#roots.get(path);
    if (open) {
      // A scan of another project still running is kept for later (see `#switchTo`).
      this.#cancelPending();
      this.#show(path, open.name, open.rootId);
      return;
    }
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
    await this.#ready;
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
    const name = opened.path.split(/[\\/]/).filter(Boolean).pop() ?? opened.path;
    if (generation !== this.#generation) {
      // Another project became active meanwhile: keep the scan for switching here later, unless
      // the project was removed or is open already.
      const listed = $projects.get().some((p) => p.id === opened.path);
      if (!listed || this.#roots.has(opened.path)) {
        closeWorkspace(opened.rootId).catch(() => {});
        return;
      }
      this.#roots = new Map([[opened.path, { rootId: opened.rootId, name }], ...this.#roots]);
      this.#evict();
      return;
    }
    addProject(opened.path, name);
    this.#show(opened.path, name, opened.rootId);
    this.#setPending(null);
  }

  /**
   * Makes an open root the active workspace.
   * @param {string} path
   * @param {string} name
   * @param {string} rootId
   */
  #show(path, name, rootId) {
    this.#roots.delete(path);
    this.#roots.set(path, { rootId, name });
    // Before the switch: the oldest is never the one still shown, as `KEEP_OPEN` is at least 2.
    this.#evict();
    $workspace.set({ path, name, rootId });
  }

  /** Closes the least recently active roots beyond `KEEP_OPEN`. */
  #evict() {
    for (const path of this.#roots.keys()) {
      if (this.#roots.size <= KEEP_OPEN) break;
      this.#closeRoot(path);
    }
  }

  /** @param {string} path Closes that project's root, if open. */
  #closeRoot(path) {
    const root = this.#roots.get(path);
    if (!root) return;
    this.#roots.delete(path);
    closeWorkspace(root.rootId).catch(() => {});
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
      this.#closeRoot(id);
      removeProjectTabs(id);
      removeProjectExpandedFolders(id);
      return;
    }
    // Leave the removed project before forgetting its tabs and folders, so nothing can write them back while
    // the next one is scanned.
    this.#close();
    removeProjectTabs(id);
    removeProjectExpandedFolders(id);
    if (next) this.activate(next.path).catch((err) => reportError('Opening project failed', err));
  }

  /** Makes an `#openFolder()` call still in flight discard its result. */
  #cancelPending() {
    this.#generation++;
    this.#setPending(null);
  }

  /** Leaves the active workspace and closes its backend root. */
  #close() {
    const path = this.path;
    $workspace.set(null);
    if (path) this.#closeRoot(path);
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
