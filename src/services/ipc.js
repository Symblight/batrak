import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';

/** @typedef {import('../models/types.js').Session} Session */
/** @typedef {import('../models/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../models/types.js').OpenedRoot} OpenedRoot */
/** @typedef {import('../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../models/types.js').QuickOpenResult} QuickOpenResult */
/** @typedef {import('../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../models/types.js').SearchEvent} SearchEvent */

/** The only module that knows Rust command names. */

/** @returns {Promise<Session[]>} */
export function listSessions() {
  return invoke('list_sessions');
}

/** @returns {Promise<string | null>} */
export function getActiveSession() {
  return invoke('get_active_session');
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export function setActiveSession(id) {
  return invoke('set_active_session', { id });
}

/**
 * Text content of a file (UTF-8).
 * @param {string} path Absolute.
 * @returns {Promise<string>}
 */
export function readFile(path) {
  return invoke('read_file', { path });
}

/**
 * Scans a folder into a snapshot and starts watching it.
 * @param {string} path
 * @returns {Promise<OpenedRoot>}
 */
export function openWorkspace(path) {
  return invoke('open_workspace', { path });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function closeWorkspace(rootId) {
  return invoke('close_workspace', { rootId });
}

/**
 * Children of a directory from the snapshot.
 * @param {string} rootId
 * @param {string} path Relative; `''` for the root.
 * @returns {Promise<WorkspaceEntry[]>}
 */
export function listDir(rootId, path) {
  return invoke('list_dir', { rootId, path });
}

/**
 * Subscribes to snapshot changes made by the file watcher.
 * @param {(changes: WorkspaceChanges) => void} callback
 * @returns {Promise<() => void>} Unsubscribe.
 */
export function onWorkspaceChanged(callback) {
  return listen('workspace://changed', (event) => callback(/** @type {WorkspaceChanges} */ (event.payload)));
}

/**
 * Fuzzy file search. A newer call cancels a running one (`cancelled: true`).
 * @param {string} rootId
 * @param {string} query
 * @returns {Promise<QuickOpenResult>}
 */
export function quickOpen(rootId, query) {
  return invoke('quick_open', { rootId, query });
}

/**
 * @param {string} rootId
 * @param {string} path Relative.
 * @returns {Promise<void>}
 */
export function noteFileOpened(rootId, path) {
  return invoke('note_file_opened', { rootId, path });
}

/**
 * Starts a content search; results stream into `onEvent` until a `done` or `error` event.
 * A new search on the same root cancels the previous one.
 * @param {string} rootId
 * @param {SearchOptions} options
 * @param {(event: SearchEvent) => void} onEvent
 * @returns {Promise<void>} Resolves once the search has started.
 */
export function findInFiles(rootId, options, onEvent) {
  /** @type {Channel<SearchEvent>} */
  const channel = new Channel();
  channel.onmessage = onEvent;
  return invoke('find_in_files', { rootId, options, channel });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function cancelSearch(rootId) {
  return invoke('cancel_search', { rootId });
}

/**
 * Shows a path in the OS file manager.
 * @param {string} path Absolute.
 * @returns {Promise<void>}
 */
export function revealPath(path) {
  return invoke('reveal_path', { path });
}

/** @returns {Promise<string>} The user's home folder. */
export function getHomeDir() {
  return homeDir();
}

/**
 * Native folder picker.
 * @returns {Promise<string | null>} Selected path, or null if cancelled.
 */
export async function pickFolder() {
  const result = await open({ directory: true, multiple: false });
  return typeof result === 'string' ? result : null;
}
