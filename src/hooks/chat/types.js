/**
 * A file or folder for the composer, as a chip like an `@` pick (`AcpChat.insertFiles()`).
 * @typedef {Object} ChatFile
 * @property {string} path Relative to the session's folder, or absolute outside it.
 * @property {boolean} folder
 */

/**
 * What the user gave a session, whatever shows it (`hooks/sessions/input-parts.js` builds it, a renderer per
 * view writes it: `promptOfInput()` for ACP, `cliPromptOf()` for the CLI).
 * @typedef {Object} SessionInput
 * @property {InputPart[]} parts In order.
 * @property {File[]} files Attachments.
 */

/**
 * A ref's or selection's `path` is relative to the session's folder, or absolute outside it. A
 * paste's `lang` is `null` for long text that isn't code.
 * @typedef {{ kind: 'text', text: string }
 *   | { kind: 'paste', text: string, lang: string | null }
 *   | { kind: 'ref', path: string, folder: boolean }
 *   | { kind: 'selection', path: string, fromLine: number, toLine: number, body: string }
 *   | { kind: 'command', name: string }} InputPart
 */

/**
 * What waits to go into a session (`$pendingInput`): code from the editors, and paths dropped from the OS.
 * @typedef {Object} PendingInput
 * @property {readonly ChatInsert[]} inserts
 * @property {readonly string[]} drops
 */

/**
 * Something from the code going into the chat's composer as a file chip labelled `path:fromLine-toLine`
 * (`path:line` for one line): a selection (`body` empty, the chip goes in at the caret) or a comment
 * (its own line: chip, then `body`).
 * @typedef {Object} ChatInsert
 * @property {string} path Absolute.
 * @property {number} fromLine 1-based.
 * @property {number} toLine 1-based.
 * @property {string} body
 */

export {};
