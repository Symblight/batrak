import { relPath } from './paths.js';

/** @typedef {import('./types.js').ChatInsert} ChatInsert */

/**
 * @param {ChatInsert} insert
 * @param {string | null} root
 */
function refOf({ path, fromLine, toLine }, root) {
  const lines = fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
  return `@${relPath(root, path) ?? path}#L${lines}`;
}

/**
 * Code from the editors as text typed into an agent's CLI, which shows no chips: each selection an
 * `@path#L3-5` ref followed by a space, then each comment on a line of its own (its ref, then its text).
 * @param {readonly ChatInsert[]} inserts
 * @param {string | null} root Refs are relative to it; a path outside it stays absolute.
 */
export function cliInput(inserts, root) {
  const selections = inserts.filter((i) => !i.body).map((i) => `${refOf(i, root)} `);
  const comments = inserts.filter((i) => i.body).map((i) => `${refOf(i, root)} ${i.body}`);
  return [...(selections.length ? [selections.join('')] : []), ...comments].join('\n');
}
