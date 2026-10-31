import { isRecord, persistentMapStore, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../models/types/types.js').SearchDialogPrefs} SearchDialogPrefs */
/** @typedef {import('../../models/types/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../models/types/types.js').ProjectSearchState} ProjectSearchState */

const MAX_RECENT = 10;
const MIN_SPLIT = 20;
const MAX_SPLIT = 80;

/** @type {SearchDialogPrefs} */
const DEFAULT_PREFS = { preview: 'bottom', view: 'grouped', splitBottom: 50, splitRight: 50 };

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function split(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value)) : fallback;
}

/**
 * Stored dialog prefs, each field checked on its own (a bad one falls back to its default).
 * @param {unknown} raw
 * @returns {SearchDialogPrefs | null}
 */
export function parseSearchDialogPrefs(raw) {
  if (!isRecord(raw)) return null;
  return {
    preview: raw.preview === 'right' || raw.preview === 'none' ? raw.preview : 'bottom',
    view: raw.view === 'flat' ? 'flat' : 'grouped',
    splitBottom: split(raw.splitBottom, DEFAULT_PREFS.splitBottom),
    splitRight: split(raw.splitRight, DEFAULT_PREFS.splitRight),
  };
}

/** The search dialog's layout: preview placement, result view and split sizes; shared by windows. */
export const $searchDialogPrefs = persistentStore('brama:search:dialog', DEFAULT_PREFS, { parse: parseSearchDialogPrefs });

/** @param {Partial<SearchDialogPrefs>} patch */
export function setSearchDialogPrefs(patch) {
  const next = parseSearchDialogPrefs({ ...$searchDialogPrefs.get(), ...patch });
  if (next) $searchDialogPrefs.set(next);
}

/**
 * A stored project's search state; a missing or bad field gets its empty value.
 * @param {unknown} raw
 * @returns {ProjectSearchState | null}
 */
export function parseProjectSearch(raw) {
  if (!isRecord(raw)) return null;
  const recent = Array.isArray(raw.recent) ? [...new Set(raw.recent.filter((q) => typeof q === 'string').map((q) => q.trim()).filter(Boolean))] : [];
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    caseSensitive: raw.caseSensitive === true,
    wholeWord: raw.wholeWord === true,
    regex: raw.regex === true,
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    mask: typeof raw.mask === 'string' ? raw.mask : '',
    recent: recent.slice(0, MAX_RECENT),
  };
}

/**
 * The search dialog's state and recent queries by project path, per window. Written only through
 * `setKey`: `set()` would rewrite every project's item from this window's copy.
 */
export const $projectSearch = persistentMapStore('brama:search:project:', parseProjectSearch);

/**
 * @param {string} project Its path.
 * @param {SearchDialogState} state
 */
export function saveProjectSearch(project, state) {
  const { query, caseSensitive, wholeWord, regex, folder, mask } = state;
  const recent = $projectSearch.get()[project]?.recent ?? [];
  $projectSearch.setKey(project, { query, caseSensitive, wholeWord, regex, folder, mask, recent });
}

/**
 * Puts a query first in the project's recent searches (once, at most 10); an empty one is ignored.
 * @param {string} project Its path.
 * @param {string} query
 */
export function addRecentSearch(project, query) {
  const trimmed = query.trim();
  if (!trimmed) return;
  const current = $projectSearch.get()[project] ?? parseProjectSearch({});
  if (!current) return;
  const recent = [trimmed, ...current.recent.filter((q) => q !== trimmed)].slice(0, MAX_RECENT);
  $projectSearch.setKey(project, { ...current, recent });
}
