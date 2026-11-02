/**
 * Where the Settings tab is to scroll.
 * @typedef {Object} SettingsReveal
 * @property {SettingsAnchor} section
 */

/** @typedef {'theme' | 'editor'} SettingsAnchor A section of the Settings tab, as its navigation lists them. */

/**
 * Column width in px by `acp-resize-handle` name (unique app-wide); a missing column uses its CSS default.
 * @typedef {Record<string, number>} ColumnWidths
 */

/**
 * Names of the columns hidden from the toolbar (`session`, `side`), as in `ColumnWidths`.
 * @typedef {string[]} HiddenColumns
 */

/** @typedef {'light' | 'dark' | 'system'} Appearance */

/**
 * An installed font family; mirrors `commands::fonts::FontFamily`.
 * @typedef {Object} FontFamily
 * @property {string} family
 * @property {boolean} monospace Any face of it is fixed-pitch.
 */

/**
 * About Brama; mirrors `commands::about::AboutInfo`.
 * @typedef {Object} AboutInfo
 * @property {string} version
 * @property {string} os Name and version, e.g. `macOS 26.1`.
 * @property {string} arch
 * @property {string | null} logDir
 */

/**
 * App preferences, shared by every window.
 * @typedef {Object} Settings
 * @property {Appearance} appearance `system` follows the OS.
 * @property {string} accent Seed colour of the MD3 palette, `#RRGGBB`.
 * @property {string | null} editorFont Code editor font family; `null` keeps the editor's own stack.
 * @property {number} editorFontSize Code editor font size in px; the line height follows it.
 * @property {import('../markdown/types.js').MarkdownMode} markdownDefaultView How a markdown file never set is shown.
 * @property {boolean} markdownScrollSync In Split, the editor and the preview scroll together.
 */

export {};
