import { absoluteRefPath, linesOf, parseFileRef, splitFileRefs } from './file-refs.js';
import { MESSAGE_PART_RULES, fenceCode, longTextPartRule, splitFencedCode } from './parts.js';
import { formatElapsed, splitThought } from './thinking.js';

/** @typedef {import('./file-refs.js').FileRef} FileRef */
/** @typedef {import('./file-refs.js').TextSegment} TextSegment */

/** The rules about what a chat shows: parts of a message, file references in text, a thought. */
export const chat = Object.freeze({
  MESSAGE_PART_RULES,
  longTextPartRule,
  fenceCode,
  splitFencedCode,
  parseFileRef,
  splitFileRefs,
  linesOf,
  absoluteRefPath,
  splitThought,
  formatElapsed,
});
