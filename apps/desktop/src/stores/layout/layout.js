import { atom, computed } from 'nanostores';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampSplit } from '../../hooks/markdown/split.js';
import { isRecord, persistentStore } from '../persistent/persistent.js';
import { $project } from '../project/project.js';

/** @typedef {import('../../hooks/settings/types.js').ColumnWidths} ColumnWidths */
/** @typedef {import('../../hooks/settings/types.js').HiddenColumns} HiddenColumns */

/** Shared by every window, so a resize shows up in all of them. */
export const $columnWidths = persistentStore('batrak:layout:column-widths', /** @type {ColumnWidths} */ ({}), {
  parse: (raw) => {
    if (!isRecord(raw)) return null;
    /** @type {ColumnWidths} */
    const widths = {};
    for (const [name, px] of Object.entries(raw)) if (typeof px === 'number' && Number.isFinite(px)) widths[name] = px;
    return widths;
  },
});

/** Shared like the widths: hiding a column hides it in every window. */
export const $hiddenColumns = persistentStore('batrak:layout:hidden-columns', /** @type {HiddenColumns} */ ([]), {
  parse: (raw) => (Array.isArray(raw) ? raw.filter((name) => typeof name === 'string') : null),
});

/** The columns hidden while this window shows no project (the welcome view). Not stored, and apart from `$hiddenColumns`: what's opened here leaves the project layout alone. */
const $welcomeHiddenColumns = atom(/** @type {HiddenColumns} */ (['session', 'side']));

/** The columns hidden right now: the saved layout, or the welcome view's while no project is shown. */
export const $shownHiddenColumns = computed([$project, $hiddenColumns, $welcomeHiddenColumns], (project, hidden, welcome) => (project ? hidden : welcome));

/** @returns {typeof $hiddenColumns | typeof $welcomeHiddenColumns} The store a show or hide changes now. */
const hiddenColumnsNow = () => ($project.get() ? $hiddenColumns : $welcomeHiddenColumns);

/**
 * Shows a hidden column, hides a shown one.
 * @param {string} name Column name, as in `$columnWidths`.
 */
export function toggleColumn(name) {
  const store = hiddenColumnsNow();
  const hidden = store.get();
  store.set(hidden.includes(name) ? hidden.filter((n) => n !== name) : [...hidden, name]);
}

/** @param {string} name */
export function showColumn(name) {
  const store = hiddenColumnsNow();
  const hidden = store.get();
  if (hidden.includes(name)) store.set(hidden.filter((n) => n !== name));
}

/** Limits of the markdown split's editor share, in percent. */
export const MARKDOWN_SPLIT_MIN = SPLIT_MIN;
export const MARKDOWN_SPLIT_MAX = SPLIT_MAX;
export const MARKDOWN_SPLIT_DEFAULT = SPLIT_DEFAULT;

/**
 * @param {unknown} raw
 * @returns {number | null} The editor's share clamped; `null` for anything but a finite number.
 */
export function parseMarkdownSplit(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) ? clampSplit(raw) : null;
}

/** The editor's share of a markdown tab in Split, in percent: one value for the window's markdown tabs, shared like the widths. */
export const $markdownSplit = persistentStore('batrak:layout:markdown-split', MARKDOWN_SPLIT_DEFAULT, { parse: parseMarkdownSplit });

/** @param {number} percent The editor's share; kept within the limits. */
export function setMarkdownSplit(percent) {
  const clamped = parseMarkdownSplit(percent);
  if (clamped !== null && clamped !== $markdownSplit.get()) $markdownSplit.set(clamped);
}
