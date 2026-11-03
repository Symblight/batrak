import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../git/types.js').WorkspaceChanges} WorkspaceChanges */

/** The Rust commands about files and folders of open roots. */

/**
 * Saves a file from the editor; only agents.json files are accepted for now.
 * @param {string} path Absolute.
 * @param {string} content
 * @returns {Promise<void>}
 */
function writeFile(path, content) {
  return ipc.invoke('write_file', { path, content });
}

/**
 * Text content of a file (UTF-8).
 * @param {string} path Absolute.
 * @returns {Promise<string>}
 */
function readFile(path) {
  return ipc.invoke('read_file', { path });
}

/**
 * Raw bytes of a file (an image), at most 64 MB.
 * @param {string} path Absolute.
 * @returns {Promise<ArrayBuffer>}
 */
function readFileBytes(path) {
  return ipc.invoke('read_file_bytes', { path });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
function closeWorkspace(rootId) {
  return ipc.invoke('close_root', { rootId });
}

/**
 * Children of a directory from the snapshot.
 * @param {string} rootId
 * @param {string} path Relative; `''` for the root.
 * @returns {Promise<WorkspaceEntry[]>}
 */
function listDir(rootId, path) {
  return ipc.invoke('list_dir', { rootId, path });
}

/**
 * Scans a root again from disk, for changes its watcher missed; they arrive as `roots://changed`.
 * @param {string} rootId
 * @returns {Promise<void>}
 */
function rescanWorkspace(rootId) {
  return ipc.invoke('rescan_root', { rootId });
}

/**
 * Subscribes to snapshot changes made by the file watcher.
 * @param {(changes: WorkspaceChanges) => void} callback
 * @returns {Promise<() => void>} Unsubscribe.
 */
function onWorkspaceChanged(callback) {
  return ipc.listen('roots://changed', callback);
}

/** @returns {Promise<string>} The user's home folder. */
function getHomeDir() {
  return ipc.homeDir();
}

export const files = Object.freeze({
  readFile,
  readFileBytes,
  writeFile,
  listDir,
  rescan: rescanWorkspace,
  closeRoot: closeWorkspace,
  onRootsChanged: onWorkspaceChanged,
  homeDir: getHomeDir,
});
