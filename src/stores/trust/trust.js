import { atom } from 'nanostores';
import { projectOf } from '../sessions/sessions.js';

/** @typedef {import('../../models/types/types.js').TrustPrompt} TrustPrompt */

/** What the trust dialog asks now; `null`: nothing waits for trust. Written by the `agents` hook. */
export const $trustPrompt = atom(/** @type {TrustPrompt | null} */ (null));

/** Sessions whose agent start was refused for want of trust; started again once it's given. */
export const $awaitingTrust = atom(/** @type {readonly string[]} */ ([]));

/** @param {string} sessionId */
export function awaitTrust(sessionId) {
  const waiting = $awaitingTrust.get();
  if (!waiting.includes(sessionId)) $awaitingTrust.set([...waiting, sessionId]);
}

/**
 * Removes and returns the sessions of a project that wait for trust.
 * @param {string} projectPath
 * @returns {string[]}
 */
export function takeAwaitingTrust(projectPath) {
  const waiting = $awaitingTrust.get();
  const taken = waiting.filter((id) => projectOf(id) === projectPath);
  if (taken.length) $awaitingTrust.set(waiting.filter((id) => !taken.includes(id)));
  return taken;
}
