import { $openingPath, $rootId, $workspace } from '../../stores/workspace/workspace.js';
import { removeProjectTabs } from '../../stores/editor/editor.js';
import { removeProjectTerminals } from '../../stores/terminals/terminals.js';
import { removeProjectExpandedFolders } from '../../stores/file-tree/file-tree.js';
import { $projects, addProject, removeProject } from '../../stores/projects/projects.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { files } from './files.js';
import { absPath, basename, isAbsolute, projectPathOf, relPath, shownPath, worktreeOf } from './rules.js';

/** @typedef {import('../git/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('./types.js').OpenedRoot} OpenedRoot */

/**
 * Projects whose backend root (snapshot + watcher) stays open, the active one included. Switching to
 * one of them needs no scan: its watcher kept the snapshot current.
 */
const KEEP_OPEN = 3;

/** Id of the latest `openFolder()` call; an older one that finishes later is discarded. */
let generation = 0;
/** @type {Map<string, { rootId: string, name: string }>} Open roots by project path, least recently active first; the active project is last. */
let roots = new Map();
/** @type {{ path: string, done: Promise<void> } | null} The latest `openFolder()` call, until it settles. */
let pending = null;
/** @type {Promise<void> | null} */
let readyPromise = null;
/** @returns {string | null} Canonical absolute path of the opened folder. */
function currentPath() {
  return $workspace.get()?.path ?? null;
}

/** @param {{ path: string, done: Promise<void> } | null} next Mirrored into `$openingPath`. */
function setPending(next) {
  pending = next;
  $openingPath.set(next?.path ?? null);
}

/** Makes an `openFolder()` call still in flight discard its result. */
function cancelPending() {
  generation++;
  setPending(null);
}

/** @param {string} path Closes that project's root, if open. */
function closeRoot(path) {
  const root = roots.get(path);
  if (!root) return;
  roots.delete(path);
  ipc.invoke('close_workspace', { rootId: root.rootId }).catch(() => {});
}

/** Closes the least recently active roots beyond `KEEP_OPEN`. */
function evict() {
  for (const path of roots.keys()) {
    if (roots.size <= KEEP_OPEN) break;
    closeRoot(path);
  }
}

/**
 * Makes an open root the active workspace.
 * @param {string} path
 * @param {string} name
 * @param {string} rootId
 */
function show(path, name, rootId) {
  roots.delete(path);
  roots.set(path, { rootId, name });
  // Before the switch: the oldest is never the one still shown, as `KEEP_OPEN` is at least 2.
  evict();
  $workspace.set({ path, name, rootId });
}

/** Leaves the active workspace and closes its backend root. */
function close() {
  const path = currentPath();
  $workspace.set(null);
  if (path) closeRoot(path);
}

/**
 * @param {string} path
 * @param {number} id Of the `openFolder()` call; the result is dropped once it is stale.
 */
async function switchTo(path, id) {
  await projects.ready();
  /** @type {OpenedRoot} */
  let opened;
  try {
    opened = await ipc.invoke('open_workspace', { path });
  } catch (err) {
    // A newer open from this window cancels the older scan in the backend; that's not a failure.
    if (id !== generation) return;
    setPending(null);
    throw err;
  }
  const name = opened.path.split(/[\\/]/).filter(Boolean).pop() ?? opened.path;
  if (id !== generation) {
    // Another project became active meanwhile: keep the scan for switching here later, unless
    // the project was removed or is open already.
    const listed = $projects.get().some((p) => p.id === opened.path);
    if (!listed || roots.has(opened.path)) {
      ipc.invoke('close_workspace', { rootId: opened.rootId }).catch(() => {});
      return;
    }
    roots = new Map([[opened.path, { rootId: opened.rootId, name }], ...roots]);
    evict();
    return;
  }
  addProject(opened.path, name);
  show(opened.path, name, opened.rootId);
  setPending(null);
}

/**
 * Opens a folder in the backend and makes it the workspace, then closes the previous root.
 * @param {string} path
 * @returns {Promise<void>}
 */
function openFolder(path) {
  const id = ++generation;
  const done = switchTo(path, id);
  setPending({ path, done });
  return done;
}

/**
 * The opened projects: the active one lives in `$workspace` (subscribe to it, or to `$rootId`, for
 * changes). The last `KEEP_OPEN` active projects keep their backend root (scan + watcher), so
 * switching back to one is instant; an older one is closed and scanned afresh when activated again.
 * Also the rules about paths: a root and a relative path, and the worktree folders of sessions.
 */
export const projects = Object.freeze({
  ...files,
  abs: absPath,
  rel: relPath,
  worktreeOf,
  projectPathOf,
  isAbsolute,
  basename,
  shownPath,

  /** @returns {string | null} Canonical absolute path of the opened folder. */
  path: currentPath,

  /** @returns {string | null} Workspace snapshot id; `null` until the backend has the folder open. */
  rootId() {
    return $rootId.get();
  },

  /**
   * @param {string} rel Path relative to the active root.
   * @returns {string} Absolute path.
   */
  absPath(rel) {
    return absPath(currentPath(), rel);
  },

  /**
   * @param {string} abs Absolute path inside the active root.
   * @returns {string | null} Relative path, or null when outside the root.
   */
  relPath(abs) {
    return relPath(currentPath(), abs);
  },

  /**
   * Settles once the roots this window's previous page load left open are closed; open nothing
   * before. Starts closing them on the first call.
   * @returns {Promise<void>}
   */
  ready() {
    readyPromise ??= ipc
      .invoke('close_window_workspaces')
      .then(() => {})
      .catch((err) => app.reportError('Closing previous projects failed', err));
    return readyPromise;
  },

  /**
   * Hands the changes of the active root's files on disk to `listener`, as the watcher reports them
   * (the other open roots' changes only reach their snapshots and git caches).
   * @param {(changes: WorkspaceChanges) => void} listener
   * @returns {() => void} Stops listening.
   */
  onFsChange(listener) {
    const stop = ipc
      .listen('workspace://changed', (/** @type {WorkspaceChanges} */ changes) => {
        if (changes.rootId === $rootId.get()) listener(changes);
      })
      .catch((err) => {
        app.reportError('File watching unavailable', err);
        return () => {};
      });
    // A listener the backend dropped already (the page going away) is gone either way.
    return () => void stop.then((off) => off()).catch(() => {});
  },

  /** Shows the folder picker and activates the chosen folder as a project. */
  async open() {
    const picked = await ipc.pickFolder();
    if (picked === null) return;
    await projects.activate(picked);
  },

  /**
   * @param {string} rootId
   * @returns {boolean} Whether a backend root is still open (active or kept for switching back).
   */
  isOpen(rootId) {
    return [...roots.values()].some((root) => root.rootId === rootId);
  },

  /**
   * Makes a project the active workspace: at once when its root is still open, else by scanning it.
   * @param {string} path Canonical absolute path (a project id).
   */
  async activate(path) {
    if (path === currentPath() && $rootId.get() !== null) return;
    const open = roots.get(path);
    if (open) {
      // A scan of another project still running is kept for later (see `switchTo`).
      cancelPending();
      show(path, open.name, open.rootId);
      return;
    }
    // A second click while it is scanning waits for that scan instead of starting another.
    if (pending?.path === path) return pending.done;
    await openFolder(path);
  },

  /** Reopens the folder persisted from the last run; forgets it if it can't be opened any more. */
  async restore() {
    // Runs at every start: the last page load's roots close even with no folder to reopen.
    projects.ready();
    const saved = $workspace.get();
    if (!saved || saved.rootId !== null) return;
    try {
      await openFolder(saved.path);
    } catch (err) {
      if ($workspace.get() === saved) $workspace.set(null);
      throw err;
    }
  },

  /**
   * Removes a project from the app; its folder on disk is untouched. When it is the active one, the next
   * project (else the previous) becomes active, or the workspace closes if none is left.
   * @param {string} id
   */
  remove(id) {
    const all = $projects.get();
    const index = all.findIndex((p) => p.id === id);
    const next = all[index + 1] ?? all[index - 1];
    const active = currentPath() === id;
    // An open of this project still in flight would list it again when it lands; drop it.
    if (active || pending?.path === id) cancelPending();
    removeProject(id);
    if (!active) {
      closeRoot(id);
      removeProjectTabs(id);
      removeProjectTerminals(id);
      removeProjectExpandedFolders(id);
      return;
    }
    // Leave the removed project before forgetting its tabs and folders, so nothing can write them back while
    // the next one is scanned.
    close();
    removeProjectTabs(id);
    removeProjectTerminals(id);
    removeProjectExpandedFolders(id);
    if (next) projects.activate(next.path).catch((err) => app.reportError('Opening project failed', err));
  },

  /**
   * Shows a folder in Finder / Explorer / the file manager; rejects anything that isn't a folder.
   * @param {string} path Absolute.
   * @returns {Promise<void>}
   */
  reveal(path) {
    return ipc.invoke('reveal_path', { path });
  },

  /**
   * Remembers a file as recently opened, for Quick Open ranking.
   * @param {string} abs
   */
  noteOpened(abs) {
    const rel = relPath(currentPath(), abs);
    const rootId = $rootId.get();
    if (rootId && rel) ipc.invoke('note_file_opened', { rootId, path: rel }).catch(() => {});
  },
});
