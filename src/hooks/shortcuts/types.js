/**
 * One key combination.
 * @typedef {Object} Combo
 * @property {string} key Shown as is; a letter in upper case.
 * @property {boolean} [mod] Command on macOS, Ctrl elsewhere.
 * @property {boolean} [ctrl] Ctrl on every platform.
 * @property {boolean} [shift]
 * @property {boolean} [alt]
 * @property {string} [then] A chord: the key pressed after this one.
 * @property {boolean} [menu] The native menu's accelerator handles it: shown, never matched.
 */

/**
 * A row of the shortcut table: one combo, or one per platform (`other`: Windows and Linux).
 * @typedef {Combo | { mac: Combo, other: Combo }} ShortcutRow
 */

export {};
