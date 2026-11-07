import { $openingPath, $project } from '../../stores/project/project.js';
import { $activeRoot, $rootId } from '../../stores/workspaces/workspaces.js';
import { removeFolderTabs } from '../../stores/editor/editor.js';
import { removeProjectTerminals } from '../../stores/terminals/terminals.js';
import { removeFolderExpandedFolders } from '../../stores/file-tree/file-tree.js';
import { $projects, addProject, removeProject } from '../../stores/projects/projects.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { files } from './files.js';
import { createRoots } from './roots.js';
import {
  absPath,
  basename,
  initialOf,
  isAbsolute,
  parentLabel,
  parentPath,
  projectPathOf,
  relPath,
  shownPath,
  tildePath,
  unreadByProject,
  worktreeOf,
} from './rules.js';

/** @typedef {import('../git/types.js').RootChanges} RootChanges */
/** @typedef {import('./types.js').OpenedRoot} OpenedRoot */

/** Backend roots (snapshot + watcher) that stay open, projects' and workspaces' together, the shown ones included. */
const KEEP_OPEN = 3;

/** Id of the latest `openFolder()` call; an older one that finishes later is discarded. */
let generation = 0;
const roots = createRoots(KEEP_OPEN, (rootId) => ipc.invoke('close_root', { rootId }).then(() => {}, () => {}));
/** @type {{ path: string, done: Promise<void> } | null} The latest `openFolder()` call, until it settles. */
let pending = null;
/** @type {Promise<void> | null} */
let readyPromise = null;
/** @returns {string | null} Canonical absolute path of the opened folder. */
function currentPath() {
  return $project.get()?.path ?? null;
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

/**
 * Makes an open root the active project.
 * @param {string} path
 * @param {string} rootId
 */
function show(path, rootId) {
  roots.show(path, rootId);
  $project.set({ path, name: basename(path), rootId });
}

/** Leaves the active project and closes its backend root. */
function close() {
  const path = currentPath();
  $project.set(null);
  if (path) void roots.close(path);
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
    opened = await ipc.invoke('open_root', { path });
  } catch (err) {
    // A newer open from this window cancels the older scan in the backend; that's not a failure.
    if (id !== generation) return;
    setPending(null);
    throw err;
  }
  if (id !== generation) {
    // Another project became active meanwhile: keep the scan for switching here later, unless
    // the project was removed or is open already.
    const listed = $projects.get().some((p) => p.id === opened.path);
    if (!listed || roots.get(opened.path) !== null) {
      ipc.invoke('close_root', { rootId: opened.rootId }).catch(() => {});
      return;
    }
    roots.keepOlder(opened.path, opened.rootId, [$project.get()?.path ?? '', $activeRoot.get().path ?? '']);
    return;
  }
  addProject(opened.path, basename(opened.path));
  show(opened.path, opened.rootId);
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
 * The opened projects: the active one lives in `$project` (subscribe to it, or to `$rootId`, for
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
  initialOf,
  tildePath,
  parentLabel,
  parentPath,
  unreadByProject,

  /** @returns {string | null} Canonical absolute path of the opened folder. */
  path: currentPath,

  /** @returns {string | null} Root snapshot id; `null` until the backend has the folder open. */
  rootId() {
    return $rootId.get();
  },

  /**
   * @param {string} rel Path relative to the active root.
   * @returns {string} Absolute path.
   */
  absPath(rel) {
    return absPath($activeRoot.get().path, rel);
  },

  /**
   * @param {string} abs Absolute path inside the active root.
   * @returns {string | null} Relative path, or null when outside the root.
   */
  relPath(abs) {
    return relPath($activeRoot.get().path, abs);
  },

  /**
   * Settles once the roots this window's previous page load left open are closed; open nothing
   * before. Starts closing them on the first call.
   * @returns {Promise<void>}
   */
  ready() {
    readyPromise ??= ipc
      .invoke('close_window_roots')
      .then(() => {})
      .catch((err) => app.reportError('Closing previous projects failed', err));
    return readyPromise;
  },

  /**
   * Hands the changes of the active root's files on disk to `listener`, as the watcher reports them
   * (the other open roots' changes only reach their snapshots and git caches).
   * @param {(changes: RootChanges) => void} listener
   * @returns {() => void} Stops listening.
   */
  onFsChange(listener) {
    const stop = ipc
      .listen('roots://changed', (/** @type {RootChanges} */ changes) => {
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
    return roots.isOpen(rootId);
  },

  /**
   * Keeps a workspace's root open while its project is shown, as the most recently shown root.
   * @param {string} folder
   * @param {string} rootId
   */
  showRoot(folder, rootId) {
    roots.show(folder, rootId, [currentPath() ?? '']);
  },

  /**
   * @param {string} folder
   * @returns {string | null} The id of its root while it's open.
   */
  openRoot(folder) {
    return roots.get(folder);
  },

  /**
   * Closes a folder's root, if open: a workspace's before its folder is deleted.
   * @param {string} folder
   * @returns {Promise<void>} Settles once nothing watches it.
   */
  closeFolder(folder) {
    return roots.close(folder);
  },

  /**
   * Makes a project the active project: at once when its root is still open, else by scanning it.
   * @param {string} path Canonical absolute path (a project id).
   */
  async activate(path) {
    if (path === currentPath() && $project.get()?.rootId) return;
    const open = roots.get(path);
    if (open !== null) {
      // A scan of another project still running is kept for later (see `switchTo`).
      cancelPending();
      show(path, open);
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
    const saved = $project.get();
    if (!saved || saved.rootId !== null) return;
    try {
      await openFolder(saved.path);
    } catch (err) {
      if ($project.get() === saved) $project.set(null);
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
      void roots.close(id);
      removeFolderTabs(id);
      removeProjectTerminals(id);
      removeFolderExpandedFolders(id);
      return;
    }
    // Leave the removed project before forgetting its tabs and folders, so nothing can write them back while
    // the next one is scanned.
    close();
    removeFolderTabs(id);
    removeProjectTerminals(id);
    removeFolderExpandedFolders(id);
    if (next) projects.activate(next.path).catch((err) => app.reportError('Opening project failed', err));
  },

  /**
   * Asks, then removes a project (its folder on disk stays).
   * @param {string} id
   * @param {{ confirm: (options: import('../app/types.js').ConfirmOptions) => Promise<boolean> }} dialog
   * @returns {Promise<boolean>} Whether it was removed.
   */
  async confirmRemove(id, dialog) {
    const project = $projects.get().find((p) => p.id === id);
    if (!project) return false;
    const confirmed = await dialog.confirm({
      headline: 'Remove project?',
      message: `${project.name} will be removed from Batrak.`,
      detail: 'The folder on disk stays.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (confirmed) projects.remove(id);
    return confirmed;
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
    const { path, rootId } = $activeRoot.get();
    const rel = relPath(path, abs);
    if (rootId && rel) ipc.invoke('note_file_opened', { rootId, path: rel }).catch(() => {});
  },
});
