/**
 * A drag of files from the OS over the window, as the webview reports it (`ipc.onDragDrop` in
 * `hooks/ipc/ipc.js`). `position` is relative to the webview's top-left corner: physical pixels on
 * Windows, logical ones on macOS and Linux (`toCssPoint()` in `hooks/file-drop/rules.js`).
 * @typedef {(
 *   | { type: 'enter' | 'drop', paths: string[], position: { x: number, y: number } }
 *   | { type: 'over', position: { x: number, y: number } }
 *   | { type: 'leave' }
 * )} FileDrag
 */

/**
 * Files dropped from the OS on a drop target (`fileDrop.onDrop()`): the column that renders
 * `target` handles it.
 * @typedef {Object} FileDrop
 * @property {Element} target The innermost drop target under the pointer (`acp-terminal`, `acp-chat`).
 * @property {string[]} paths Absolute.
 */

/**
 * A dropped path and what it is on disk (`dropped_kinds`): `other` when it's gone or neither a
 * regular file nor a folder.
 * @typedef {Object} DroppedEntry
 * @property {string} path Absolute.
 * @property {'file' | 'folder' | 'other'} kind
 */

export {};
