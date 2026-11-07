/**
 * Where the Settings tab is to scroll.
 * @typedef {Object} SettingsReveal
 * @property {SettingsAnchor} section
 */

/** @typedef {'theme' | 'editor' | 'terminal' | 'agents'} SettingsAnchor A section of the Settings tab, as its navigation lists them. */

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
 * About Batrak; mirrors `commands::about::AboutInfo`.
 * @typedef {Object} AboutInfo
 * @property {string} version
 * @property {string} os Name and version, e.g. `macOS 26.1`.
 * @property {string} arch
 * @property {string | null} logDir
 * @property {boolean} updatesEnabled This build has **Check for updates** (not a debug build).
 */

/** @typedef {'background' | 'foreground' | 'cursor' | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'} TerminalColorKey */

/**
 * A terminal's colors, `#RRGGBB`; the keys are xterm's.
 * @typedef {Record<TerminalColorKey, string>} TerminalPalette
 */

/**
 * A custom terminal theme: a palette per scheme.
 * @typedef {Object} TerminalColors
 * @property {TerminalPalette} light
 * @property {TerminalPalette} dark
 */

/**
 * A project's own accent.
 * @typedef {Object} ProjectAccent
 * @property {string} color `#RRGGBB`, kept while switched off.
 * @property {boolean} enabled It is used over the global accent.
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
 * @property {string | null} terminalFont Terminal font family; `null` follows the editor's.
 * @property {number | null} terminalFontSize Terminal font size in px; `null` follows the editor's.
 * @property {'app' | 'custom'} terminalTheme Whose colors the terminal has; `custom` always has `terminalColors`.
 * @property {TerminalColors | null} terminalColors Kept while the theme is `app`, for going back.
 * @property {boolean} terminalOptionMeta macOS: ⌥ sends ESC and the key in a terminal, instead of composing a character.
 */

export {};
