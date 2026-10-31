/** @typedef {import('./types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('./types.js').SearchMatchRow} SearchMatchRow */

/** Characters kept before a match when a long line's start is cut. */
const CONTEXT_BEFORE = 8;

/**
 * One row per match range, in result order.
 * @param {SearchFileResult[]} results
 * @returns {SearchMatchRow[]}
 */
export function matchRows(results) {
  /** @type {SearchMatchRow[]} */
  const rows = [];
  for (const { path, matches } of results) {
    for (const match of matches) {
      // UTF-16 units the backend cut from the line's start (its 500-byte window).
      const offset = /** @type {{ offset?: number }} */ (match).offset ?? 0;
      for (const [start, end] of match.ranges) {
        rows.push({
          key: `${path}:${match.line}:${start}`,
          path,
          line: match.line,
          column: offset + start + 1,
          length: end - start,
          text: match.text,
          start,
          end,
        });
      }
    }
  }
  return rows;
}

/**
 * @param {SearchFileResult[]} results
 * @returns {{ matches: number, files: number }}
 */
export function countMatches(results) {
  let matches = 0;
  for (const result of results) for (const line of result.matches) matches += line.ranges.length;
  return { matches, files: results.length };
}

/**
 * The results' one-line summary: the error as is, `''` for an empty query.
 * @param {{ results: SearchFileResult[], searching: boolean, error: string | null, query: string }} state
 */
export function summaryText({ results, searching, error, query }) {
  if (error) return error;
  if (!query) return '';
  const { matches, files } = countMatches(results);
  if (searching) return `Searching… ${matches} results in ${files} files`;
  return matches === 0 ? 'No results' : `${matches} results in ${files} files`;
}

/**
 * A line split into plain text and hits; a range overlapping an earlier one is skipped.
 * @param {string} text
 * @param {[number, number][]} ranges `[start, end)`, in order.
 * @returns {{ text: string, hit: boolean }[]}
 */
export function highlightParts(text, ranges) {
  /** @type {{ text: string, hit: boolean }[]} */
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * A line as a row shows it: leading whitespace dropped, and when the match ends past `max`, the
 * start cut to `…` so the match shows with a little context before it.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} max Characters a row shows.
 * @returns {{ text: string, start: number, end: number }}
 */
export function clipLine(text, start, end, max) {
  const indent = Math.min(text.length - text.trimStart().length, start);
  let clipped = { text: text.slice(indent), start: start - indent, end: end - indent };
  const cut = clipped.start - CONTEXT_BEFORE;
  if (clipped.end > max && cut > 1) {
    clipped = { text: `…${clipped.text.slice(cut)}`, start: clipped.start - cut + 1, end: clipped.end - cut + 1 };
  }
  return clipped;
}

/**
 * The key `step` rows away from `key` among rows outside `collapsed` files. One step wraps around,
 * longer ones stop at the ends; no or an unknown `key` gives the first row.
 * @param {SearchMatchRow[]} rows
 * @param {Set<string>} collapsed Paths of collapsed files.
 * @param {string | null} key
 * @param {number} step
 * @returns {string | null}
 */
export function moveKey(rows, collapsed, key, step) {
  const visible = rows.filter((row) => !collapsed.has(row.path));
  if (!visible.length) return null;
  const at = key === null ? -1 : visible.findIndex((row) => row.key === key);
  if (at < 0) return visible[0].key;
  const n = visible.length;
  const next = Math.abs(step) === 1 ? (((at + step) % n) + n) % n : Math.max(0, Math.min(n - 1, at + step));
  return visible[next].key;
}
