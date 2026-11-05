/** Limits and start of the editor's share of a markdown tab in Split, in percent. */
export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 50;

/** @param {number} percent */
export const clampSplit = (percent) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent));
