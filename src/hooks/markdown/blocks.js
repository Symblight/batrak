/** Tokens that render to nothing: they take lines but never a node. */
const SILENT = new Set(['space', 'def']);

/**
 * @typedef {Object} BlockStart
 * @property {number} line 1-based line of the source where the block begins.
 * @property {string} raw The block's source, as `marked` lexed it.
 */

/** @param {string} text */
const newlinesIn = (text) => text.split('\n').length - 1;

/**
 * Where each top-level block that renders to something starts in the source.
 * @param {readonly { type: string, raw: string }[]} tokens `marked`'s top-level tokens.
 * @returns {BlockStart[]}
 */
export function blockStarts(tokens) {
  /** @type {BlockStart[]} */
  const starts = [];
  let line = 1;
  for (const { type, raw } of tokens) {
    if (!SILENT.has(type)) starts.push({ line, raw });
    line += newlinesIn(raw);
  }
  return starts;
}

/**
 * A heading's id the way GitHub forms it: lowercase, punctuation dropped, spaces to `-`.
 * @param {string} text
 */
export function slugOf(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Hands out the slugs of one document: a repeated one is numbered `-1`, `-2`.
 * @returns {(text: string) => string}
 */
export function createSlugger() {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return (text) => {
    const slug = slugOf(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  };
}
