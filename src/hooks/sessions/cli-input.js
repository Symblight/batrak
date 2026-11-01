import { chat } from '../chat/chat.js';
import { relPath } from '../projects/rules.js';
import { inputOfInserts, linesOf } from './input-parts.js';

/** @typedef {import('../../models/types/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types/types.js').InputPart} InputPart */

/**
 * A session's input as text for its agent's CLI, which shows no chips: refs as `@path` (a folder
 * `@path/`), selections as `@path#L3-5`, commands as `/name`, pasted code fenced.
 * @param {readonly InputPart[]} parts
 * @param {string | null} root Absolute paths inside it are written relative to it.
 */
export function cliPromptOf(parts, root) {
  const pathOf = (/** @type {string} */ path) => relPath(root, path) ?? path;
  let text = '';
  for (const part of parts) {
    if (part.kind === 'text') text += part.text;
    else if (part.kind === 'paste') text += part.lang === null ? part.text : chat.fenceCode(part.text, part.lang);
    else if (part.kind === 'ref') text += `@${pathOf(part.path)}${part.folder ? '/' : ''}`;
    else if (part.kind === 'selection') text += `@${pathOf(part.path)}#L${linesOf(part)}${part.body ? ` ${part.body}` : ''}`;
    else if (part.kind === 'command') text += `/${part.name}`;
  }
  return text.replace(/^\n+|\n+$/g, '');
}

/**
 * Code from the editors as text typed into an agent's CLI: each selection an `@path#L3-5` ref
 * followed by a space, then each comment on a line of its own (its ref, then its text).
 * @param {readonly ChatInsert[]} inserts
 * @param {string | null} root Refs are relative to it; a path outside it stays absolute.
 */
export function cliInput(inserts, root) {
  return cliPromptOf(inputOfInserts(inserts), root);
}
