import { ipc } from '../../hooks/ipc/ipc.js';

/** @typedef {import('../../models/types/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../../models/types/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../../models/types/types.js').QuickOpenResult} QuickOpenResult */
/** @typedef {import('../../models/types/types.js').QuickOpenKind} QuickOpenKind */
/** @typedef {import('../../models/types/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types/types.js').SearchEvent} SearchEvent */

/** The Rust command names, until each feature's hook takes its own. The bridge is `hooks/ipc`. */






















/**
 * Saves a file from the editor; only agents.json files are accepted for now.
 * @param {string} path Absolute.
 * @param {string} content
 * @returns {Promise<void>}
 */
export function writeFile(path, content) {
  return ipc.invoke('write_file', { path, content });
}

/**
 * Text content of a file (UTF-8).
 * @param {string} path Absolute.
 * @returns {Promise<string>}
 */
export function readFile(path) {
  return ipc.invoke('read_file', { path });
}

/**
 * Raw bytes of a file (an image), at most 64 MB.
 * @param {string} path Absolute.
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileBytes(path) {
  return ipc.invoke('read_file_bytes', { path });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function closeWorkspace(rootId) {
  return ipc.invoke('close_workspace', { rootId });
}


/**
 * Children of a directory from the snapshot.
 * @param {string} rootId
 * @param {string} path Relative; `''` for the root.
 * @returns {Promise<WorkspaceEntry[]>}
 */
export function listDir(rootId, path) {
  return ipc.invoke('list_dir', { rootId, path });
}

/**
 * Scans a root again from disk, for changes its watcher missed; they arrive as `workspace://changed`.
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function rescanWorkspace(rootId) {
  return ipc.invoke('rescan_workspace', { rootId });
}

/**
 * Subscribes to snapshot changes made by the file watcher.
 * @param {(changes: WorkspaceChanges) => void} callback
 * @returns {Promise<() => void>} Unsubscribe.
 */
export function onWorkspaceChanged(callback) {
  return ipc.listen('workspace://changed', callback);
}

/** @typedef {'about' | 'settings' | 'new-terminal'} MenuAction */

/**
 * Clicks on the app's own menu bar items (macOS), sent to the focused window.
 * @param {(id: MenuAction) => void} callback
 * @returns {Promise<() => void>} Stops listening.
 */
export function onMenuAction(callback) {
  return ipc.listen('menu://action', callback);
}

/**
 * Fuzzy file search. A newer call cancels a running one (`cancelled: true`).
 * @param {string} rootId
 * @param {string} query
 * @param {QuickOpenKind} [kind] Files, files and folders, or folders only.
 * @returns {Promise<QuickOpenResult>}
 */
export function quickOpen(rootId, query, kind = 'files') {
  return ipc.invoke('quick_open', { rootId, query, kind });
}


/**
 * Starts a content search; results stream into `onEvent` until a `done` or `error` event.
 * A new search on the same root and slot cancels the previous one.
 * @param {string} rootId
 * @param {string} slot Whose search it is: `'panel'`, `'dialog'`.
 * @param {SearchOptions} options
 * @param {(event: SearchEvent) => void} onEvent
 * @returns {Promise<void>} Resolves once the search has started.
 */
export function findInFiles(rootId, slot, options, onEvent) {
  return ipc.invoke('find_in_files', { rootId, slot, options, channel: ipc.channel(onEvent) });
}

/**
 * @param {string} rootId
 * @param {string} slot
 * @returns {Promise<void>}
 */
export function cancelSearch(rootId, slot) {
  return ipc.invoke('cancel_search', { rootId, slot });
}

/**
 * Opens a web or mail link in the default app.
 * @param {string} url `http(s):` or `mailto:`; anything else is refused.
 * @returns {Promise<void>}
 */
export function openUrl(url) {
  return ipc.invoke('open_url', { url });
}

/**
 * Shows a folder in the OS file manager; rejects anything that isn't a folder.
 * @param {string} path Absolute.
 * @returns {Promise<void>}
 */
export function revealPath(path) {
  return ipc.invoke('reveal_path', { path });
}

/** @returns {Promise<string>} The user's home folder. */
export function getHomeDir() {
  return ipc.homeDir();
}

/**
 * Native folder picker.
 * @returns {Promise<string | null>} Selected path, or null if cancelled.
 */
export function pickFolder() {
  return ipc.pickFolder();
}

/**
 * Saves a file attached in the composer into `folder`'s attachments (`.brama/attachments/`, which
 * git ignores), where the agent reads it by its path.
 * @param {string} folder A folder of an open project or a session's.
 * @param {File} file
 * @returns {Promise<string>} Its absolute path.
 */
export async function saveAttachment(folder, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return ipc.invoke('save_attachment', bytes, { headers: { folder: encodeURIComponent(folder), name: encodeURIComponent(file.name) } });
}

