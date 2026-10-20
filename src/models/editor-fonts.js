/** The editor's font when none is picked: first in `--font-family-mono`, bundled in `styles/fonts/`. */
export const DEFAULT_EDITOR_FONT = 'Google Sans Code';

/**
 * @param {string} family
 * @returns {string} CSS `font-family` value; the app's monospace stack takes over if `family` is gone.
 */
export function fontStack(family) {
  return `"${family}", var(--font-family-mono)`;
}
