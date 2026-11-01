import { isRecord, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/settings/types.js').ColumnWidths} ColumnWidths */
/** @typedef {import('../../hooks/settings/types.js').HiddenColumns} HiddenColumns */

/** Shared by every window, so a resize shows up in all of them. */
export const $columnWidths = persistentStore('brama:layout:column-widths', /** @type {ColumnWidths} */ ({}), {
  parse: (raw) => {
    if (!isRecord(raw)) return null;
    /** @type {ColumnWidths} */
    const widths = {};
    for (const [name, px] of Object.entries(raw)) if (typeof px === 'number' && Number.isFinite(px)) widths[name] = px;
    return widths;
  },
});

/** Shared like the widths: hiding a column hides it in every window. */
export const $hiddenColumns = persistentStore('brama:layout:hidden-columns', /** @type {HiddenColumns} */ ([]), {
  parse: (raw) => (Array.isArray(raw) ? raw.filter((name) => typeof name === 'string') : null),
});

/**
 * Shows a hidden column, hides a shown one.
 * @param {string} name Column name, as in `$columnWidths`.
 */
export function toggleColumn(name) {
  const hidden = $hiddenColumns.get();
  $hiddenColumns.set(hidden.includes(name) ? hidden.filter((n) => n !== name) : [...hidden, name]);
}

/** @param {string} name */
export function showColumn(name) {
  const hidden = $hiddenColumns.get();
  if (hidden.includes(name)) $hiddenColumns.set(hidden.filter((n) => n !== name));
}
