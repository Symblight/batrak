import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').Session} Session */

/** Every agent session, as the backend lists them; written by `sessionController`. */
export const $sessions = atom(/** @type {Session[]} */ ([]));

/** Written by `sessionController`. */
export const $activeSessionId = atom(/** @type {string | null} */ (null));
