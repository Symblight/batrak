import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').AboutInfo} AboutInfo */

/** Versions for Settings > About; `null` until `loadAbout()` has them. */
export const $about = atom(/** @type {AboutInfo | null} */ (null));
