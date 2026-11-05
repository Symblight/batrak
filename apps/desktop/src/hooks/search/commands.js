import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').QuickOpenResult} QuickOpenResult */
/** @typedef {import('./types.js').QuickOpenKind} QuickOpenKind */
/** @typedef {import('./types.js').SearchOptions} SearchOptions */
/** @typedef {import('./types.js').SearchEvent} SearchEvent */

/** The Rust commands of Quick Open and the search in files. */

/**
 * Fuzzy file search. A newer call cancels a running one (`cancelled: true`).
 * @param {string} rootId
 * @param {string} query
 * @param {QuickOpenKind} [kind] Files, files and folders, or folders only.
 * @returns {Promise<QuickOpenResult>}
 */
function quickOpen(rootId, query, kind = 'files') {
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
function findInFiles(rootId, slot, options, onEvent) {
  return ipc.invoke('find_in_files', { rootId, slot, options, channel: ipc.channel(onEvent) });
}

/**
 * @param {string} rootId
 * @param {string} slot
 * @returns {Promise<void>}
 */
function cancelSearch(rootId, slot) {
  return ipc.invoke('cancel_search', { rootId, slot });
}

export const searchCommands = Object.freeze({ quickOpen, find: findInFiles, cancel: cancelSearch });
