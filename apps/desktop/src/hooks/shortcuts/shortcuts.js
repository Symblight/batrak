import { app } from '../app/app.js';
import { comboOf, keyMatches } from './keys.js';

/** @typedef {import('../app/types.js').Platform} Platform */
/** @typedef {import('./types.js').Combo} Combo */
/** @typedef {import('./types.js').ShortcutRow} ShortcutRow */
/** @typedef {Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>} KeyPress */

/** @typedef {keyof typeof TABLE} ShortcutId */

/**
 * A workspace number's row: ⌥⌘digit on macOS, Ctrl+Shift+digit elsewhere.
 * @param {string} digit
 * @returns {ShortcutRow}
 */
function workspaceRow(digit) {
  return { mac: { mod: true, alt: true, key: digit }, other: { ctrl: true, shift: true, key: digit } };
}

/** Every shortcut the app owns; handlers check their keys with `matches()`. */
const TABLE = Object.freeze(
  /** @satisfies {Record<string, ShortcutRow>} */ ({
    quickOpen: { mod: true, key: 'P' },
    openFolder: { mod: true, key: 'O' },
    searchInFiles: { mod: true, shift: true, key: 'F' },
    toggleSessionView: { mod: true, shift: true, key: 'T' },
    markProjectRead: { mod: true, shift: true, key: 'R' },
    newTerminal: { ctrl: true, key: '`' },
    save: { mod: true, key: 'S' },
    find: { mod: true, key: 'F' },
    commit: { mod: true, key: '↵' },
    markdownSplit: { mod: true, key: 'K', then: 'V' },
    markdownPreview: { mod: true, shift: true, key: 'V' },
    matchCase: { alt: true, key: 'C' },
    wholeWord: { alt: true, key: 'W' },
    regex: { alt: true, key: 'R' },
    focusSelectionActions: { alt: true, key: 'F10' },
    // On macOS the menu's Settings… item has ⌘,.
    settings: { mac: { mod: true, key: ',', menu: true }, other: { ctrl: true, key: ',' } },
    openWorkspaces: { mod: true, shift: true, key: 'O' },
    nextWaitingWorkspace: { mod: true, shift: true, key: 'J' },
    // In the terminal on Windows / Linux, Ctrl+N stays the shell's.
    newWorkspace: { mod: true, key: 'N' },
    newChat: { mod: true, shift: true, key: 'N' },
    // ⇧⌘3/4/5 are screenshots on macOS; Ctrl+Alt+digit is AltGr elsewhere. 1 is Main.
    workspace1: workspaceRow('1'),
    workspace2: workspaceRow('2'),
    workspace3: workspaceRow('3'),
    workspace4: workspaceRow('4'),
    workspace5: workspaceRow('5'),
    workspace6: workspaceRow('6'),
    workspace7: workspaceRow('7'),
    workspace8: workspaceRow('8'),
    workspace9: workspaceRow('9'),
  }),
);

const MAC_SYMBOLS = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' };

/**
 * @param {Combo} combo
 * @param {Platform} platform
 * @returns {('ctrl' | 'alt' | 'shift' | 'mod')[]} The modifiers in the order the platform writes them.
 */
function modifiers({ ctrl, alt, shift, mod }, platform) {
  const order = platform === 'mac' ? ['ctrl', 'alt', 'shift', 'mod'] : ['mod', 'ctrl', 'alt', 'shift'];
  const held = { ctrl, alt, shift, mod };
  return /** @type {('ctrl' | 'alt' | 'shift' | 'mod')[]} */ (order.filter((m) => held[/** @type {keyof typeof held} */ (m)]));
}

/**
 * @param {ShortcutId} id
 * @param {Platform} platform
 */
function combo(id, platform) {
  return comboOf(TABLE[id], platform);
}

/**
 * The shortcut table: what to show next to a control, what to tell assistive technology, and
 * whether a key press is a shortcut.
 */
export const shortcuts = Object.freeze({
  /** Every row's id. */
  ids: /** @type {readonly ShortcutId[]} */ (Object.freeze(Object.keys(TABLE))),

  /**
   * The text for a hint: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere.
   * @param {ShortcutId} id
   * @param {Platform} [platform]
   */
  hint(id, platform = app.platform) {
    const shortcut = combo(id, platform);
    const mods = modifiers(shortcut, platform);
    const chord = shortcut.then ? ` ${shortcut.then}` : '';
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
    const shortcut = combo(id, platform);
    const names = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', mod: platform === 'mac' ? 'Meta' : 'Control' };
    return [...modifiers(shortcut, 'windows').map((m) => names[m]), shortcut.key].join('+');
  },

  /**
   * Shortcuts that differ only in their key, as one hint: `Alt+C/W/R`.
   * @param {ShortcutId[]} ids
   * @param {Platform} [platform]
   */
  group(ids, platform = app.platform) {
    return [shortcuts.hint(ids[0], platform), ...ids.slice(1).map((id) => combo(id, platform).key)].join('/');
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

  /**
   * The key press is the shortcut (its first stroke, for a chord): the key, and exactly its
   * modifiers (Mod is ⌘ on macOS, Ctrl elsewhere, where the Windows / Super key must be up).
   * Never for a combo the native menu handles.
   * @param {ShortcutId} id
   * @param {KeyPress} e
   * @param {Platform} [platform]
   */
  matches(id, e, platform = app.platform) {
    const shortcut = combo(id, platform);
    if (shortcut.menu || !keyMatches(shortcut.key, e)) return false;
    const mac = platform === 'mac';
    const meta = mac && !!shortcut.mod;
    const ctrl = !!shortcut.ctrl || (!mac && !!shortcut.mod);
    return e.metaKey === meta && e.ctrlKey === ctrl && e.altKey === !!shortcut.alt && e.shiftKey === !!shortcut.shift;
  },

  /**
   * The key press is a chord's second stroke: its key, with Alt and Shift up (Mod / Ctrl may be held).
   * @param {ShortcutId} id
   * @param {KeyPress} e
   * @param {Platform} [platform]
   */
  matchesThen(id, e, platform = app.platform) {
    const then = combo(id, platform).then;
    return !!then && !e.altKey && !e.shiftKey && keyMatches(then, e);
  },
});
