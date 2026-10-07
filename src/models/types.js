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
 * What a main-column tab shows: a file, or a view (Settings; Changes, every changed file's diff).
 * @typedef {'file' | 'settings' | 'changes'} TabKind
 */

/**
 * Open editor tabs.
 * @typedef {Object} EditorTabs
 * @property {string[]} paths Tab ids in strip order: a file's absolute path, or a view's id
 *   (`SETTINGS_TAB_ID`, `CHANGES_TAB_ID`); see `parseTabId()` in `stores/editor.js`.
 * @property {string | null} active Tab id.
 */

/**
 * Column width in px by `acp-resize-handle` name (unique app-wide); a missing column uses its CSS default.
 * @typedef {Record<string, number>} ColumnWidths
 */

/** @typedef {'light' | 'dark' | 'system'} Appearance */

/**
 * An installed font family; mirrors `commands::fonts::FontFamily`.
 * @typedef {Object} FontFamily
 * @property {string} family
 * @property {boolean} monospace Any face of it is fixed-pitch.
 */

/**
 * App preferences, shared by every window.
 * @typedef {Object} Settings
 * @property {Appearance} appearance `system` follows the OS.
 * @property {string} accent Seed colour of the MD3 palette, `#RRGGBB`.
 * @property {string | null} editorFont Code editor font family; `null` keeps the editor's own stack.
 * @property {number} editorFontSize Code editor font size in px; the line height follows it.
 */

/**
 * Payload of the `workspace://changed` event. All paths are relative.
 * @typedef {Object} WorkspaceChanges
 * @property {string} rootId
 * @property {string[]} dirs Directories whose child list changed (`''` = root).
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} modified
 * @property {boolean} git The repository's HEAD, index or refs changed.
 */

/**
 * Branch of the root's repository; mirrors `git::repo::RepoState`.
 * @typedef {Object} GitRepoState
 * @property {string | null} branch `null` when detached.
 * @property {string | null} sha `null` before the first commit.
 * @property {boolean} detached
 * @property {string | null} upstream
 * @property {number} ahead
 * @property {number} behind
 */

/** @typedef {'modified' | 'added' | 'deleted' | 'renamed' | 'typeChanged' | 'untracked' | 'conflicted'} GitFileKind */

/**
 * A changed file; mirrors `git::repo::FileStatus`.
 * @typedef {Object} GitFileStatus
 * @property {string} path A file, relative to the root; untracked folders are listed file by file.
 * @property {GitFileKind} kind
 * @property {boolean} staged
 * @property {boolean} unstaged
 * @property {string | null} origPath Rename source.
 * @property {number | null} added Lines added against HEAD; `null` when unknown (binary, too large).
 * @property {number | null} removed Lines removed against HEAD.
 */

/**
 * @typedef {Object} GitStatus
 * @property {GitRepoState} repo
 * @property {GitFileStatus[]} files
 */

/**
 * Branch of the active root (`$gitRepo`), kept current while a project is open.
 * @typedef {Object} GitRepoView
 * @property {GitRepoState | null} repo `null` outside a repository or until first read.
 * @property {string | null} error Why it couldn't be read, e.g. "git not found".
 */

/**
 * Changed files of the active root (`$gitChanges`), computed only while the Changes panel is open.
 * @typedef {Object} GitChangesView
 * @property {GitFileStatus[]} files
 * @property {boolean} loaded A status has arrived since the panel opened.
 * @property {boolean} loading
 * @property {string | null} error
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
