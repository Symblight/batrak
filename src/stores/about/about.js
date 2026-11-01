import { atom } from 'nanostores';

/** @typedef {import('../../hooks/settings/types.js').AboutInfo} AboutInfo */

/** Versions for Settings > About; `null` until `loadAbout()` has them. */
export const $about = atom(/** @type {AboutInfo | null} */ (null));
