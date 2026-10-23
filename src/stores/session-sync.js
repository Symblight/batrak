import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').SessionSync} SessionSync */
/** @typedef {import('../models/types.js').SyncReport} SyncReport */

/** Each project's sync with its agents this launch, by project id; written by `sessionController`. */
export const $sessionSync = atom(/** @type {Readonly<Record<string, SessionSync>>} */ ({}));

/** @type {SessionSync} */
const NONE = { running: false, report: null };

/**
 * @param {string} projectId
 * @returns {SessionSync}
 */
export function syncOf(projectId) {
  return $sessionSync.get()[projectId] ?? NONE;
}

/** @param {string} projectId */
export function startSync(projectId) {
  $sessionSync.set({ ...$sessionSync.get(), [projectId]: { ...syncOf(projectId), running: true } });
}

/**
 * @param {string} projectId
 * @param {SyncReport | null} report `null`: it failed; the last report stays.
 */
export function endSync(projectId, report) {
  $sessionSync.set({ ...$sessionSync.get(), [projectId]: { running: false, report: report ?? syncOf(projectId).report } });
}
