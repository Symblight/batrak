import { chipPartRule } from '@symblight/chat';
import { codeBlockPastePartRule } from '@symblight/chat/composer';

/** Matches the paste chip of a long text that isn't code. */
export const longTextPartRule = {
  type: 'longText',
  selector: 'span[data-paste-lines]:not([data-lang])',
  toPart: (/** @type {HTMLElement} */ element) => ({
    text: element.textContent ?? '',
    lines: Number(element.dataset.pasteLines) || 0,
  }),
};

/** How a sent message's flat html splits into parts: chips (files, commands) and pastes. */
export const MESSAGE_PART_RULES = [chipPartRule, codeBlockPastePartRule, longTextPartRule];

/**
 * A code part as it's written into a prompt's text: a Markdown fence on lines of its own.
 * @param {string} code
 * @param {string} lang
 */
export function fenceCode(code, lang) {
  return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

const FENCE = /(?:^|\n)```([^\n`]*)\n([\s\S]*?)\n```(?:\n|$)/g;

/**
 * A recorded prompt's text as the parts it was sent with: the fences `fenceCode()` wrote become code
 * parts again, the rest text.
 * @param {string} text
 * @returns {({ type: 'text', text: string } | { type: 'code', text: string, lang: string })[]}
 */
export function splitFencedCode(text) {
  /** @type {ReturnType<typeof splitFencedCode>} */
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
    parts.push({ type: 'code', text: match[2], lang: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}
