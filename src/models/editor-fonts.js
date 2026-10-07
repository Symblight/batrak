/**
 * @param {string} family
 * @returns {string} CSS `font-family` value; the app's monospace stack takes over if `family` is gone.
 */
export function fontStack(family) {
  return `"${family}", var(--font-family-mono)`;
}
