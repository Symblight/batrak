import { atom } from 'nanostores';

/** @typedef {import('../../hooks/settings/types.js').FontFamily} FontFamily */

/** Installed font families, sorted by name; `null` until `loadSystemFonts()` has listed them. */
export const $systemFonts = atom(/** @type {FontFamily[] | null} */ (null));
