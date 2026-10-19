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
