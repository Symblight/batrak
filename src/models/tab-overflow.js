/**
 * Where a tab lies along the strip, in any one coordinate space shared with the view.
 * @typedef {Object} TabSpan
 * @property {string} id
 * @property {number} start
 * @property {number} end
 */

/** Sub-pixel layout rounding. */
const EPSILON = 0.5;

/**
 * The tabs not fully visible in the strip, in strip order: past either edge, or partly under an edge's
 * fade. None while every tab fits the strip, so a tab sitting under a fade with nothing to scroll isn't one.
 * @param {readonly TabSpan[]} spans In strip order.
 * @param {{ start: number, end: number }} view The scroller's visible box.
 * @param {number} fade Width of each edge's fade.
 * @returns {string[]}
 */
export function hiddenTabs(spans, view, fade) {
  if (spans.every((s) => s.start >= view.start - EPSILON && s.end <= view.end + EPSILON)) return [];
  const start = view.start + fade - EPSILON;
  const end = view.end - fade + EPSILON;
  return spans.filter((s) => s.start < start || s.end > end).map((s) => s.id);
}
