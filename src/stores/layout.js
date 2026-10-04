import { isRecord, persistentStore } from './persistent.js';

/** @typedef {import('../models/types.js').ColumnWidths} ColumnWidths */

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
