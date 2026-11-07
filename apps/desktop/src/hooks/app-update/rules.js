/** @typedef {import('./types.js').AppUpdateState} AppUpdateState */

/**
 * What the restart dialog says.
 * @param {{ agents: number, terminals: number, drafts: number }} busy
 * @returns {string | null} `null` when a restart loses nothing, so nothing is asked.
 */
export function restartMessage({ agents, terminals, drafts }) {
  /** @type {string[]} */
  const stopped = [];
  if (agents > 0) stopped.push(agents === 1 ? '1 agent is working' : `${agents} agents are working`);
  if (terminals > 0) stopped.push(terminals === 1 ? '1 terminal is running a program' : `${terminals} terminals are running a program`);
  /** @type {string[]} */
  const sentences = [];
  if (stopped.length > 0) sentences.push(`${stopped.join(', ')}.`, `Restarting stops ${agents + terminals === 1 ? 'it' : 'them'}.`);
  if (agents > 0) sentences.push('You can continue each session after the update.');
  if (drafts > 0) sentences.push(`${drafts === 1 ? '1 file has' : `${drafts} files have`} unsaved edits, which will be lost.`);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/**
 * What About's row says after a check.
 * @param {AppUpdateState} state What the check returned.
 * @param {string} running The running version.
 */
export function checkMessage(state, running) {
  return state.state === 'none' || state.state === 'updated' ? `Batrak ${running} is up to date` : `Batrak ${state.version} is available`;
}

const MEGABYTE = 1024 * 1024;

/**
 * How far a download is.
 * @param {number} received Bytes.
 * @param {number | null} total Bytes; `null` until known.
 * @returns {{ percent: number | null, size: string }} `percent` is `null` with no known total.
 */
export function downloadProgress(received, total) {
  const mb = Math.round(received / MEGABYTE);
  if (!total) return { percent: null, size: `${mb} MB` };
  return { percent: Math.floor((received * 100) / total), size: `${mb} of ${Math.round(total / MEGABYTE)} MB` };
}
