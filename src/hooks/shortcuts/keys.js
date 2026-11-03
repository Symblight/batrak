/** @typedef {import('../app/types.js').Platform} Platform */
/** @typedef {import('./types.js').Combo} Combo */
/** @typedef {import('./types.js').ShortcutRow} ShortcutRow */

/** `KeyboardEvent.code` of the keys that are neither letters, digits nor F-keys. */
const CODES = Object.freeze({ '`': 'Backquote', ',': 'Comma' });

/**
 * The combo a row means on a platform.
 * @param {ShortcutRow} row
 * @param {Platform} platform
 * @returns {Combo}
 */
export function comboOf(row, platform) {
  if ('mac' in row) return platform === 'mac' ? row.mac : row.other;
  return row;
}

/**
 * The physical key (`KeyboardEvent.code`) of a key label, `null` for one the table can't name.
 * @param {string} key
 * @returns {string | null}
 */
export function codeOf(key) {
  if (/^[A-Z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return CODES[/** @type {keyof typeof CODES} */ (key)] ?? null;
}

const LATIN = /^[a-z0-9]$/i;

/**
 * The event's key is the label's: by the letter or digit when both are Latin ones (Dvorak, AZERTY
 * press what their key shows), else by position (a non-Latin layout, ⌥ on macOS, Shift+digit, and
 * every key that is no letter or digit).
 * @param {string} key
 * @param {Pick<KeyboardEvent, 'key' | 'code'>} e
 */
export function keyMatches(key, e) {
  if (LATIN.test(key) && LATIN.test(e.key)) return e.key.toLowerCase() === key.toLowerCase();
  return e.code === codeOf(key);
}
