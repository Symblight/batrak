import { reportError } from '../notices/notices.js';

/**
 * Copies text to the clipboard; a failure shows a snackbar.
 * @param {string} text
 * @param {string} what What failed if it can't, e.g. `Copying the path failed`.
 */
export function copyText(text, what) {
  navigator.clipboard.writeText(text).catch((err) => reportError(what, err));
}
