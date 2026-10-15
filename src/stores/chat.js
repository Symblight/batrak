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
