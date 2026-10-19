import { chipPartRule } from '@symblight/chat';

/** Matches the paste chip `chx-paste-long-text` serializes; code pastes carry `data-lang`. */
export const codePartRule = {
  type: 'code',
  selector: 'span[data-paste-lines][data-lang]',
  toPart: (/** @type {HTMLElement} */ element) => ({
    text: element.textContent ?? '',
    lang: element.dataset.lang ?? '',
  }),
};

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
export const MESSAGE_PART_RULES = [chipPartRule, codePartRule, longTextPartRule];
