/**
 * @typedef {Object} QuickOpenItem
 * @property {string} path Relative.
 * @property {string} name
 * @property {boolean} isDir
 * @property {number[]} indices Matched characters in `path` (code points), ascending.
 */

/**
 * @typedef {Object} QuickOpenResult
 * @property {QuickOpenItem[]} items
 * @property {boolean} cancelled Superseded by a newer query.
 */

/**
 * What Quick Open lists: files, files and folders, or folders only.
 * @typedef {'files' | 'all' | 'dirs'} QuickOpenKind
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
 * @property {number} offset UTF-16 units cut from the line's start (0 unless it was long); a
 *   match's 1-based column is `offset + start + 1`.
 */

/**
 * A file's Find in Files matches.
 * @typedef {Object} SearchFileResult
 * @property {string} path Root-relative.
 * @property {LineMatch[]} matches
 */

/**
 * Streamed Find in Files message; mirrors `workspace::search::SearchEvent`.
 * @typedef {{ kind: 'file', path: string, matches: LineMatch[] }
 *   | { kind: 'done', total: number, limitHit: boolean, cancelled: boolean }
 *   | { kind: 'error', message: string, source: SearchErrorSource }} SearchEvent
 */

/**
 * What made a search fail: the query (a bad regex) or an include / exclude glob.
 * @typedef {'query' | 'filter'} SearchErrorSource
 */

/**
 * Where to put the caret in a file: a 1-based line, or a range on it (a search match) to select;
 * `column` 1-based and `length` in UTF-16 units.
 * @typedef {number | { line: number, column: number, length: number }} RevealAt
 */

/**
 * One Find in Files match, a row of `<acp-search-results>`.
 * @typedef {Object} SearchMatchRow
 * @property {string} key `path:line:start`, unique per match.
 * @property {string} path Root-relative.
 * @property {number} line 1-based.
 * @property {number} column 1-based, in UTF-16 units of the whole line.
 * @property {number} length In UTF-16 units.
 * @property {string} text The line (or its window) as the backend sent it.
 * @property {number} start `[start, end)` of the match in `text`.
 * @property {number} end
 */

/**
 * What the search dialog searches for; `folder` root-relative, `''` for the whole project.
 * @typedef {Object} SearchDialogState
 * @property {string} query
 * @property {boolean} caseSensitive
 * @property {boolean} wholeWord
 * @property {boolean} regex
 * @property {string} folder
 * @property {string} mask Comma-separated globs, `!` excludes.
 */

/**
 * A project's search dialog state with its recent queries, most recent first.
 * @typedef {SearchDialogState & { recent: string[] }} ProjectSearchState
 */

/**
 * The search dialog's layout, shared by all windows. Splits are percentages, 20–80.
 * @typedef {Object} SearchDialogPrefs
 * @property {'bottom' | 'right' | 'none'} preview
 * @property {'flat' | 'grouped'} view
 * @property {number} splitBottom
 * @property {number} splitRight
 */

/**
 * The file the search dialog previews, or why it couldn't be read.
 * @typedef {{ path: string, content: string } | { path: string, error: string }} SearchPreview
 */

export {};
