/**
 * @typedef {Object} BlockStart
 * @property {number} line 1-based line of the source where the block begins.
 * @property {string} raw The block's source lines.
 */

/**
 * Where each top-level block starts in the source. `markdown-it` maps every block token to its lines
 * and gives none to what renders to nothing (blank lines, link definitions).
 * @param {readonly { level: number, nesting: number, map: [number, number] | null }[]} tokens `markdown-it`'s tokens of the text.
 * @param {string} text The text they were parsed from.
 * @returns {BlockStart[]}
 */
export function blockStarts(tokens, text) {
  const lines = text.split(/\r\n|\r|\n/);
  /** @type {BlockStart[]} */
  const starts = [];
  for (const { level, nesting, map } of tokens) {
    if (level !== 0 || nesting === -1 || !map) continue;
    starts.push({ line: map[0] + 1, raw: lines.slice(map[0], map[1]).join('\n') });
  }
  return starts;
}

/**
 * Where a line starts in the text.
 * @param {string} text
 * @param {number} line 1-based.
 */
export function lineStart(text, line) {
  const eol = /\r\n|\r|\n/g;
  for (let n = 1; n < line; n++) if (!eol.exec(text)) return text.length;
  return eol.lastIndex;
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
