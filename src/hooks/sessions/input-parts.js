import { splitMessageParts } from '@symblight/chat';
import { chat } from '../chat/chat.js';

/** @typedef {import('../../models/types/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types/types.js').InputPart} InputPart */
/** @typedef {import('../../models/types/types.js').SessionInput} SessionInput */
/** @typedef {NonNullable<import('@symblight/chat').ChxChat['adapter']>} ChxChatAdapter */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['sendMessage']>>[0]} ChxMessage */
/** @typedef {ChxMessage['parts'][number]} ChxMessagePart */

/**
 * A chip's lines: `12` or `12-23`.
 * @param {unknown} lines
 * @returns {[number, number] | null}
 */
function lineRange(lines) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(lines ?? ''));
  if (!match) return null;
  const from = Number(match[1]);
  return [from, Number(match[2] ?? from)];
}

/**
 * A selection's lines as refs write them: `12`, or `12-23` for several.
 * @param {{ fromLine: number, toLine: number }} selection
 */
export function linesOf({ fromLine, toLine }) {
  return fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
}

/**
 * A message's parts (split, see `inputOfMessage()`) as what they name: a chip is its file, folder,
 * lines or command, never its label.
 * @param {readonly ChxMessagePart[]} parts
 * @returns {InputPart[]}
 */
export function inputOfParts(parts) {
  /** @type {InputPart[]} */
  const input = [];
  for (const part of parts) {
    if (part.type === 'text') {
      input.push({ kind: 'text', text: part.text ?? '' });
    } else if (part.type === 'code') {
      input.push({ kind: 'paste', text: part.text ?? '', lang: part.lang ?? '' });
    } else if (part.type === 'longText') {
      input.push({ kind: 'paste', text: part.text ?? '', lang: null });
    } else if (part.type === 'chip') {
      const path = typeof part.data?.path === 'string' ? part.data.path : null;
      const range = lineRange(part.data?.lines);
      const label = part.label ?? '';
      if (path && range) input.push({ kind: 'selection', path, fromLine: range[0], toLine: range[1], body: '' });
      else if (path) input.push({ kind: 'ref', path, folder: part.data?.kind === 'folder' });
      else if (label.startsWith('/')) input.push({ kind: 'command', name: label.slice(1) });
      else input.push({ kind: 'text', text: label });
    }
  }
  return input;
}

/**
 * A sent message: `<chx-chat>` sends one flat html part, which splits into chips and pastes again.
 * @param {ChxMessage} message
 * @returns {InputPart[]}
 */
export function inputOfMessage(message) {
  const flat = message.parts.length === 1 && typeof message.parts[0].html === 'string' ? message.parts[0] : null;
  return inputOfParts((flat && splitMessageParts(message.id, flat.html ?? '', chat.MESSAGE_PART_RULES)) ?? message.parts);
}

/**
 * What a composer's send (`chx-send-message`) holds: its html, not its plain `value`, where a chip is
 * only its label.
 * @param {string} id Any id, for the split parts.
 * @param {string} html
 * @param {readonly File[]} files
 * @returns {SessionInput}
 */
export function inputOfComposer(id, html, files) {
  const parts = splitMessageParts(id, html, chat.MESSAGE_PART_RULES) ?? [{ type: 'text', html, text: plainText(html) }];
  return { parts: inputOfParts(/** @type {ChxMessagePart[]} */ (parts)), files: [...files] };
}

/**
 * The text of html with no chips: its lines (top-level `<div>`s) joined by line breaks.
 * @param {string} html
 */
function plainText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = [...doc.body.children];
  return lines.length ? lines.map((line) => line.textContent ?? '').join('\n') : (doc.body.textContent ?? '');
}

/**
 * Code from the editors: each selection followed by a space, then each comment on a line of its own.
 * @param {readonly ChatInsert[]} inserts Absolute paths.
 * @returns {InputPart[]}
 */
export function inputOfInserts(inserts) {
  /** @type {InputPart[]} */
  const parts = [];
  for (const { path, fromLine, toLine } of inserts.filter((i) => !i.body)) {
    parts.push({ kind: 'selection', path, fromLine, toLine, body: '' }, { kind: 'text', text: ' ' });
  }
  for (const { path, fromLine, toLine, body } of inserts.filter((i) => i.body)) {
    if (parts.length) parts.push({ kind: 'text', text: '\n' });
    parts.push({ kind: 'selection', path, fromLine, toLine, body });
  }
  return parts;
}
