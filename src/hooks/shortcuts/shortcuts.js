import { app } from '../app/app.js';

/** @typedef {import('../app/types.js').Platform} Platform */

/**
 * @typedef {Object} Shortcut
 * @property {string} key Shown as is; a letter in upper case.
 * @property {boolean} [mod] Command on macOS, Ctrl elsewhere.
 * @property {boolean} [ctrl] Ctrl on every platform.
 * @property {boolean} [shift]
 * @property {boolean} [alt]
 * @property {string} [then] A chord: the key pressed after this one.
 */

/** @typedef {keyof typeof TABLE} ShortcutId */

/** Every shortcut the app owns; the handlers read the keys themselves. */
const TABLE = Object.freeze({
  quickOpen: { mod: true, key: 'P' },
  openFolder: { mod: true, key: 'O' },
  searchInFiles: { mod: true, shift: true, key: 'F' },
  toggleSessionView: { mod: true, shift: true, key: 'T' },
  markProjectRead: { mod: true, shift: true, key: 'R' },
  newTerminal: { ctrl: true, key: '`' },
  save: { mod: true, key: 'S' },
  find: { mod: true, key: 'F' },
  markdownSplit: { mod: true, key: 'K', then: 'V' },
  markdownPreview: { mod: true, shift: true, key: 'V' },
  matchCase: { alt: true, key: 'C' },
  wholeWord: { alt: true, key: 'W' },
  regex: { alt: true, key: 'R' },
});

const MAC_SYMBOLS = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' };

/**
 * @param {Shortcut} shortcut
 * @param {Platform} platform
 * @returns {('ctrl' | 'alt' | 'shift' | 'mod')[]} The modifiers in the order the platform writes them.
 */
function modifiers({ ctrl, alt, shift, mod }, platform) {
  const order = platform === 'mac' ? ['ctrl', 'alt', 'shift', 'mod'] : ['mod', 'ctrl', 'alt', 'shift'];
  const held = { ctrl, alt, shift, mod };
  return /** @type {('ctrl' | 'alt' | 'shift' | 'mod')[]} */ (order.filter((m) => held[/** @type {keyof typeof held} */ (m)]));
}

/**
 * The shortcut table: what to show next to a control and what to tell assistive technology.
 */
export const shortcuts = Object.freeze({
  /**
   * The text for a hint: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere.
   * @param {ShortcutId} id
   * @param {Platform} [platform]
   */
  hint(id, platform = app.platform) {
    const shortcut = TABLE[id];
    const mods = modifiers(shortcut, platform);
    const chord = 'then' in shortcut ? ` ${shortcut.then}` : '';
    if (platform === 'mac') return mods.map((m) => MAC_SYMBOLS[m]).join('') + shortcut.key + chord;
    const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', mod: 'Ctrl' };
    return [...mods.map((m) => names[m]), shortcut.key].join('+') + chord;
  },

  /**
   * The `aria-keyshortcuts` value: `Meta+Shift+F` on macOS, `Control+Shift+F` elsewhere.
   * @param {ShortcutId} id
   * @param {Platform} [platform]
   */
  aria(id, platform = app.platform) {
    const shortcut = TABLE[id];
    const names = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', mod: platform === 'mac' ? 'Meta' : 'Control' };
    return [...modifiers(shortcut, 'windows').map((m) => names[m]), shortcut.key].join('+');
  },

  /**
   * Shortcuts that differ only in their key, as one hint: `Alt+C/W/R`.
   * @param {ShortcutId[]} ids
   * @param {Platform} [platform]
   */
  group(ids, platform = app.platform) {
    return [shortcuts.hint(ids[0], platform), ...ids.slice(1).map((id) => TABLE[id].key)].join('/');
  },

  /**
   * A control's label with its hint: `Match case (Alt+C)`.
   * @param {string} label
   * @param {ShortcutId} id
   * @param {Platform} [platform]
   */
  labelled(label, id, platform = app.platform) {
    return `${label} (${shortcuts.hint(id, platform)})`;
  },
});
