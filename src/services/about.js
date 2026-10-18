import { getAbout } from './ipc.js';
import { log } from './logger.js';
import { $about } from '../stores/about.js';

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

