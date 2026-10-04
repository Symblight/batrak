/**
 * Shared data model (JSDoc only). Session mirrors the Rust struct in
 * src-tauri/src/session/mod.rs field by field.
 */

/**
 * Project listed in the session column (`$projects`); only `name` and `path` are persisted.
 * @typedef {Object} Project
 * @property {string} id Same as `path`; sessions refer to it by `projectId`.
 * @property {string} name Last path segment.
 * @property {string} path Canonical absolute path.
 */

/**
 * `waiting`: blocked on the user, e.g. a permission request.
 * @typedef {'working' | 'waiting' | 'idle' | 'error'} SessionStatus
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} projectId
 * @property {string} title
 * @property {SessionStatus} status
 * @property {string} agentId
 * @property {string | null} model
 * @property {string | null} worktreePath
 * @property {string | null} baseCommit
 * @property {string} createdAt
 */

/**
 * @typedef {Object} Checkpoint
 * @property {string} id
 * @property {string} sessionId
 * @property {string} commit
 * @property {string} createdAt
 */

/**
 * @typedef {Object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted'} kind
 */

/**
 * @typedef {Object} Instruction
 * @property {string} id
 * @property {string} sessionId
 * @property {string} text
 * @property {string} createdAt
 */

/**
 * Workspace snapshot entry; mirrors `workspace::snapshot::Entry`.
 * @typedef {Object} WorkspaceEntry
 * @property {string} name
 * @property {string} path Relative to the root, `/`-separated.
 * @property {boolean} isDir
 * @property {boolean} ignored Matched by .gitignore & co: shown dimmed, not searched.
 * @property {number} size
 * @property {number} mtime Milliseconds since the Unix epoch.
 */

/**
 * @typedef {Object} OpenedRoot
 * @property {string} rootId
 * @property {string} path Canonical absolute path of the root.
 */

/**
 * The opened folder. `path` and `name` are persisted; `rootId` exists only while the backend has the
 * folder open (`null` from launch until it's reopened).
 * @typedef {Object} Workspace
 * @property {string} path Canonical absolute path.
 * @property {string} name Last path segment.
 * @property {string | null} rootId Workspace snapshot id; every workspace command takes it.
 */

/**
 * Open editor tabs.
 * @typedef {Object} EditorTabs
 * @property {string[]} paths Absolute, in tab strip order.
 * @property {string | null} active
 */

/**
 * Column width in px by `acp-resize-handle` name (unique app-wide); a missing column uses its CSS default.
 * @typedef {Record<string, number>} ColumnWidths
 */

/**
 * Payload of the `workspace://changed` event. All paths are relative.
 * @typedef {Object} WorkspaceChanges
 * @property {string} rootId
 * @property {string[]} dirs Directories whose child list changed (`''` = root).
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} modified
 */

/**
 * @typedef {Object} QuickOpenItem
 * @property {string} path Relative.
 * @property {string} name
 * @property {number[]} indices Matched characters in `path` (code points), ascending.
 */

/**
 * @typedef {Object} QuickOpenResult
 * @property {QuickOpenItem[]} items
 * @property {boolean} cancelled Superseded by a newer query.
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string} query
 * @property {boolean} caseSensitive
 * @property {boolean} wholeWord
 * @property {boolean} regex
 * @property {string} include Comma-separated globs.
 * @property {string} exclude Comma-separated globs.
 */

/**
 * @typedef {Object} LineMatch
 * @property {number} line 1-based.
 * @property {string} text
 * @property {[number, number][]} ranges `[start, end)` in UTF-16 code units of `text`.
 */

/**
 * Streamed Find in Files message; mirrors `workspace::search::SearchEvent`.
 * @typedef {{ kind: 'file', path: string, matches: LineMatch[] }
 *   | { kind: 'done', total: number, limitHit: boolean, cancelled: boolean }
 *   | { kind: 'error', message: string }} SearchEvent
 */

export {};
