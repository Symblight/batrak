import { shortcuts } from '../shortcuts/shortcuts.js';

/** @typedef {'caseSensitive' | 'wholeWord' | 'regex'} SearchOptionKey */
/** @typedef {import('../shortcuts/shortcuts.js').KeyPress} KeyPress */

/** @type {[import('../shortcuts/shortcuts.js').ShortcutId, SearchOptionKey][]} */
const OPTIONS = [
  ['matchCase', 'caseSensitive'],
  ['wholeWord', 'wholeWord'],
  ['regex', 'regex'],
];

/**
 * The search option `matchCase` / `wholeWord` / `regex` (Alt+C / W / R) toggles.
 * @param {KeyPress} e
 * @returns {SearchOptionKey | null}
 */
export function optionForKey(e) {
  return OPTIONS.find(([id]) => shortcuts.matches(id, e))?.[1] ?? null;
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
