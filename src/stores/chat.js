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
