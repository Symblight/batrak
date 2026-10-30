import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').ChatInsert} ChatInsert */

/** Chips for the chat's composer from the code (selections, comments); `<acp-chat>` takes them. */
export const $chatInserts = atom(/** @type {readonly ChatInsert[]} */ ([]));

/** @param {readonly ChatInsert[]} inserts */
export function addToChat(inserts) {
  if (inserts.length) $chatInserts.set([...$chatInserts.get(), ...inserts]);
}

/** @returns {readonly ChatInsert[]} The waiting inserts, now no longer waiting. */
export function takeChatInserts() {
  const inserts = $chatInserts.get();
  if (inserts.length) $chatInserts.set([]);
  return inserts;
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
