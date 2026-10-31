import { atom } from 'nanostores';
import { $activeSessionId } from '../sessions/sessions.js';

/** @typedef {import('../../models/types/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types/types.js').PendingInput} PendingInput */

/**
 * What waits to go into a session (the one shown when it came): code from the editors (selections,
 * `<acp-comment-bar>`'s comments) and files dropped from the OS. It goes in once the session's
 * composer is up or its CLI runs (`<acp-agent-column>`), never dropped meanwhile.
 * @type {import('nanostores').WritableAtom<Readonly<Record<string, PendingInput>>>}
 */
export const $pendingInput = atom({});

/** @returns {PendingInput} */
const nothingPending = () => ({ inserts: [], drops: [] });

/**
 * @param {Partial<PendingInput>} added
 * @param {string | null} sessionId With none (no project open) nothing can take it.
 */
function addPending({ inserts = [], drops = [] }, sessionId) {
  if (sessionId === null) return;
  const now = $pendingInput.get()[sessionId] ?? nothingPending();
  $pendingInput.set({ ...$pendingInput.get(), [sessionId]: { inserts: [...now.inserts, ...inserts], drops: [...now.drops, ...drops] } });
}

/**
 * Code for the shown session's composer, or its CLI.
 * @param {readonly ChatInsert[]} inserts
 */
export function addToChat(inserts) {
  if (inserts.length) addPending({ inserts }, $activeSessionId.get());
}

/**
 * Files dropped from the OS on a session's chat or CLI.
 * @param {readonly string[]} paths
 * @param {string | null} [sessionId] The shown session's by default.
 */
export function addDrop(paths, sessionId = $activeSessionId.get()) {
  if (paths.length) addPending({ drops: paths }, sessionId);
}

/**
 * @param {string} sessionId
 * @returns {boolean} Something waits to go into it.
 */
export function hasPendingInput(sessionId) {
  return sessionId in $pendingInput.get();
}

/**
 * @param {string} sessionId
 * @returns {PendingInput} What waits for it, now no longer waiting.
 */
export function takePendingInput(sessionId) {
  const { [sessionId]: pending, ...rest } = $pendingInput.get();
  if (!pending) return nothingPending();
  $pendingInput.set(rest);
  return pending;
}

/** @param {string} sessionId A removed session's. */
export function forgetPendingInput(sessionId) {
  const { [sessionId]: gone, ...rest } = $pendingInput.get();
  if (gone) $pendingInput.set(rest);
}

/** Prompts the backend dropped unsent (a held turn cancelled), by session id: back into its composer. */
export const $returnedPrompts = atom(/** @type {Readonly<Record<string, string>>} */ ({}));

/**
 * @param {string} sessionId
 * @param {string} text
 */
export function returnPrompt(sessionId, text) {
  if (text) $returnedPrompts.set({ ...$returnedPrompts.get(), [sessionId]: text });
}

/**
 * @param {string} sessionId
 * @returns {string | null} The session's returned prompt, now no longer waiting.
 */
export function takeReturnedPrompt(sessionId) {
  const { [sessionId]: text, ...rest } = $returnedPrompts.get();
  if (text === undefined) return null;
  $returnedPrompts.set(rest);
  return text;
}

/**
 * Sessions whose cached messages the chat drops, so their agent's next replay rebuilds them (a
 * session back from its CLI, which ran turns the chat never saw).
 */
export const $historyResets = atom(/** @type {readonly string[]} */ ([]));

/** @param {string} sessionId */
export function resetHistory(sessionId) {
  if (!$historyResets.get().includes(sessionId)) $historyResets.set([...$historyResets.get(), sessionId]);
}

/** @returns {readonly string[]} The sessions to drop, now no longer waiting. */
export function takeHistoryResets() {
  const ids = $historyResets.get();
  if (ids.length) $historyResets.set([]);
  return ids;
}
