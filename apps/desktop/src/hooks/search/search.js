import { searchCommands } from './commands.js';
import { filterLabel, searchFilters, splitPatterns } from './filters.js';
import { initialQuery, optionForKey } from './options.js';
import { MAX_MATCHES, clipLine, countMatches, highlightParts, matchRows, moveKey, summaryText } from './results.js';

/** @typedef {import('./options.js').SearchOptionKey} SearchOptionKey */

/**
 * The rules of searching in files: what a search starts from and which options a key toggles, how a
 * folder and a mask become the backend's filters, and how results become rows, a summary and
 * highlights; and the backend's Quick Open and search in files. The groups are private parts
 * (`options.js`, `filters.js`, `results.js`, `commands.js`).
 */
export const search = Object.freeze({
  ...searchCommands,
  optionForKey,
  initialQuery,
  splitPatterns,
  filters: searchFilters,
  filterLabel,
  maxMatches: MAX_MATCHES,
  matchRows,
  countMatches,
  summary: summaryText,
  highlightParts,
  clipLine,
  moveKey,
});
