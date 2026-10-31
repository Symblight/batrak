/** @typedef {'caseSensitive' | 'wholeWord' | 'regex'} SearchOptionKey */

/** @type {Record<string, SearchOptionKey>} */
const OPTION_KEYS = { KeyC: 'caseSensitive', KeyW: 'wholeWord', KeyR: 'regex' };

/**
 * The search option Alt+C / Alt+W / Alt+R toggles, read from `code` (Alt+C types `ç` on macOS).
 * @param {Pick<KeyboardEvent, 'code' | 'altKey' | 'metaKey' | 'ctrlKey'>} e
 * @returns {SearchOptionKey | null}
 */
export function optionForKey(e) {
  if (!e.altKey || e.metaKey || e.ctrlKey) return null;
  return OPTION_KEYS[e.code] ?? null;
}
