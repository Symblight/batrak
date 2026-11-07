import { atom } from 'nanostores';

/** @typedef {import('../../hooks/app-update/types.js').AppUpdateState} AppUpdateState */
/** @typedef {import('../../hooks/app-update/types.js').UpdateCheck} UpdateCheck */

/** What the backend says about updating the app. */
export const $appUpdate = atom(/** @type {AppUpdateState} */ ({ state: 'none' }));

/** About's row: the check asked from it. */
export const NO_CHECK = Object.freeze({ checking: false, message: null });
export const $updateCheck = atom(/** @type {UpdateCheck} */ (NO_CHECK));
