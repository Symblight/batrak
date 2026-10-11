import { getAbout } from './ipc.js';
import { log } from './logger.js';
import { $about } from '../stores/about.js';

/** @typedef {import('../models/types.js').AboutInfo} AboutInfo */

/** @type {Promise<void> | null} */
let loading = null;

/** Reads the versions into `$about`, once per window; a failure lets the next call retry. */
export function loadAbout() {
  loading ??= getAbout()
    .then((about) => $about.set(about))
    .catch((err) => {
      loading = null;
      log('warn', `reading About failed: ${err}`);
    });
  return loading;
}

/**
 * Label and value of each About row, in display order.
 * @param {AboutInfo} about
 * @returns {[string, string][]}
 */
export function aboutRows(about) {
  return [
    ['Version', about.version],
    ['OS', `${about.os} ${about.arch}`],
    ['Logs', about.logDir ?? 'unknown'],
  ];
}
