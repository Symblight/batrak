import { onBackendNotice } from './ipc.js';
import { log } from './logger.js';
import { notify } from '../stores/notices.js';

/**
 * Logs a failed action and shows it in a snackbar.
 * @param {string} what What failed, e.g. `Opening folder failed`.
 * @param {unknown} error
 */
export function reportError(what, error) {
  const reason = error instanceof Error ? error.message : String(error);
  log('warn', `${what}: ${reason}`);
  notify('error', `${what}: ${reason}`);
}

/** Shows the backend's warnings and errors as snackbars; the backend has logged them already. */
export function showBackendNotices() {
  onBackendNotice(({ level, message }) => notify(level, message)).catch((err) =>
    log('warn', `backend notices unavailable: ${err}`),
  );
}
