import { chat } from '../chat/chat.js';
import { projects } from '../projects/projects.js';
import { inputOfMessage, linesOf } from './input-parts.js';

/** @typedef {import('./message-builder.js').ChxMessage} ChxMessage */
/** @typedef {import('../../models/types/types.js').PromptInput} PromptInput */
/** @typedef {import('../../models/types/types.js').InputPart} InputPart */

/**
 * A session's input as an ACP prompt: its text with refs written inline (`@path`, `@folder/`,
 * `path:12-23`), then a resource for each (a mention, or the lines it names); a file outside the
 * session's folder (an absolute path) is named in the text only.
 * @param {readonly InputPart[]} parts
 * @returns {PromptInput[]}
 */
export function promptOfInput(parts) {
  let text = '';
  /** @type {PromptInput[]} */
  const resources = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      text += part.text;
    } else if (part.kind === 'paste') {
      text += part.lang === null ? part.text : chat.fenceCode(part.text, part.lang);
    } else if (part.kind === 'command') {
      text += `/${part.name}`;
    } else if (part.kind === 'selection') {
      text += `${part.path}:${linesOf(part)}${part.body ? ` ${part.body}` : ''}`;
      resources.push({ type: 'selection', path: part.path, fromLine: part.fromLine, toLine: part.toLine });
    } else if (part.kind === 'ref') {
      // A folder ends in a slash, so the agent (and a restored message) can tell it from a file.
      text += part.folder ? `@${part.path}/` : `@${part.path}`;
      // An absolute one is outside the session's folder (dropped from elsewhere), which a mention
      // can't name: the agent reads it by its path.
      if (!projects.isAbsolute(part.path)) resources.push({ type: 'mention', path: part.path });
    }
  }
  // TODO: attachments (images) as ACP image blocks, once the agent's promptCapabilities are known.
  return [...(text.trim() ? [{ type: /** @type {const} */ ('text'), text: text.trim() }] : []), ...resources];
}

/**
 * The prompt of a sent message.
 * @param {ChxMessage} message
 * @returns {PromptInput[]}
 */
export function promptOf(message) {
  return promptOfInput(inputOfMessage(message));
}
