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

/** The longest selection a search starts from. */
const MAX_SELECTION_QUERY = 200;

/**
 * The query a search opens with: the editor's selection when it is on one line and short (trimmed),
 * else the project's last query.
 * @param {string | undefined} selection
 * @param {string} last
 */
export function initialQuery(selection, last) {
  const trimmed = selection?.trim() ?? '';
  if (!trimmed || trimmed.includes('\n') || trimmed.length > MAX_SELECTION_QUERY) return last;
  return trimmed;
}
