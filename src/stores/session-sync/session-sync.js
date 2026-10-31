import { atom } from 'nanostores';

/** @typedef {import('../../models/types/types.js').SessionSync} SessionSync */
/** @typedef {import('../../models/types/types.js').SyncReport} SyncReport */

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
 * @param {SyncReport | null} report Merged into the last one by agent (a sync may ask only some);
 *   `null`: it failed, the last report stays.
 */
export function endSync(projectId, report) {
  const last = syncOf(projectId).report;
  $sessionSync.set({
    ...$sessionSync.get(),
    [projectId]: { running: false, report: report === null || last === null ? (report ?? last) : merged(last, report) },
  });
}

/**
 * @param {SyncReport} last
 * @param {SyncReport} report
 * @returns {SyncReport} `report` with `last`'s agents it didn't ask, in their order; new ones last.
 */
function merged(last, report) {
  const byId = new Map(report.agents.map((a) => [a.agentId, a]));
  const agents = last.agents.map((a) => byId.get(a.agentId) ?? a);
  const known = new Set(last.agents.map((a) => a.agentId));
  return { ...report, agents: [...agents, ...report.agents.filter((a) => !known.has(a.agentId))] };
}
