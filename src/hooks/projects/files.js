import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').RootEntry} RootEntry */

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
 * Children of a directory from the snapshot.
 * @param {string} rootId
 * @param {string} path Relative; `''` for the root.
 * @returns {Promise<RootEntry[]>}
 */
function listDir(rootId, path) {
  return ipc.invoke('list_dir', { rootId, path });
}

/**
 * Scans a root again from disk, for changes its watcher missed; they arrive as `roots://changed`.
 * @param {string} rootId
 * @returns {Promise<void>}
 */
function rescan(rootId) {
  return ipc.invoke('rescan_root', { rootId });
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
  rescan,
  homeDir: getHomeDir,
});
