/**
 * What a main-column tab shows: a file, or a view (Settings; Changes, every changed file's diff;
 * Terminal; Browser).
 * @typedef {'file' | 'settings' | 'agents' | 'changes' | 'workspace-changes' | 'terminal' | 'browser'} TabKind
 */

/**
 * Which view renders a tab's content: a file's by its extension (`code` for any other), a view tab's
 * by its kind. Picked by `TabContentController`.
 * @typedef {'code' | 'markdown' | 'image' | 'settings' | 'agents' | 'changes' | 'workspace-changes' | 'terminal' | 'browser'} ContentKind
 */

/**
 * Open editor tabs.
 * @typedef {Object} EditorTabs
 * @property {string[]} paths Tab ids in strip order: a file's absolute path, or a view's id
 *   (`SETTINGS_TAB_ID`, `CHANGES_TAB_ID`, `BROWSER_TAB_ID`, `terminalTabId()`); see `parseTabId()` in `stores/editor.js`.
 * @property {string | null} active Tab id.
 * @property {string[]} pinned Pinned tab ids, the first tabs of `paths` in the same order. Close Others
 *   and Close All leave them open.
 */

/**
 * An open tab with what it shows; which tabs are open, and the active one, live in `$editorTabs`.
 * @typedef {Object} EditorTab
 * @property {string} id Its id in `$editorTabs`.
 * @property {TabKind} kind
 * @property {string} path The file, absolute; `''` for a view (Settings, Changes, Terminal, Browser).
 * @property {string} content
 * @property {string} error
 * @property {boolean} loaded Whether `content` and `baseline` (or `image`) are current. Only the active
 *   tab is read (and only when its view shows the file, `readsFile()`); the others are read, or re-read
 *   after a change on disk, when they become active.
 * @property {Blob | null} image An image tab's bytes, typed by its extension; `null` until read.
 * @property {string | null} baseline The file at HEAD, for the diff gutter; `null` when it has none.
 * @property {string | null} draft Unsaved edits (only editable files: `isAgentsFile()`, or any while `editorEditable` is on); `null` when
 *   the editor shows what's on disk. A change on disk doesn't replace it.
 * @property {boolean} changedOnDisk With a draft: the file on disk is no longer `content`, the text the
 *   draft started from. Save then asks before writing over it.
 * @property {boolean} deletedOnDisk The file was deleted since it was read; the tab still shows it,
 *   and a save creates it again.
 */

/**
 * An expanded file's diff in the Changes tab: the file now against the file at HEAD.
 * @typedef {Object} FileDiff
 * @property {string} content `''` for a deleted file.
 * @property {string} baseline `''` for a new file.
 * @property {string} error
 * @property {boolean} loading
 */

export {};
