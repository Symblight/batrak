import { $about } from '../../stores/about/about.js';
import { notify } from '../../stores/notices/notices.js';
import { ipc } from '../ipc/ipc.js';

/** @typedef {import('../../models/types/types.js').AboutInfo} AboutInfo */
/** @typedef {import('../../models/types/types.js').LogLevel} LogLevel */
/** @typedef {import('../../models/types/types.js').NoticeLevel} NoticeLevel */
/** @typedef {import('../../models/types/types.js').Platform} Platform */

/** @typedef {'about' | 'settings' | 'new-terminal'} MenuAction */

/**
 * @param {string} userAgent
 * @returns {Platform}
 */
function platformOf(userAgent) {
  if (/Mac/.test(userAgent)) return 'mac';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
}

const platform = platformOf(navigator.userAgent);

/** @type {Promise<void> | null} */
let aboutLoading = null;

/**
 * Message and stack of whatever was thrown.
 * @param {unknown} error
 */
function describe(error) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * The app itself: the OS it runs on, its log, the errors it shows, the clipboard, About.
 */
export const app = Object.freeze({
  /** The OS this page runs on. */
  platform,

  /** What reveals a file in this OS's file manager. */
  revealLabel: { mac: 'Show in Finder', windows: 'Show in Explorer', linux: 'Show in File Manager' }[platform],

  platformOf,

  /**
   * Label and value of each About row, in display order.
   * @param {AboutInfo} about
   * @returns {[string, string][]}
   */
  aboutRows(about) {
    return [
      ['Version', about.version],
      ['OS', `${about.os} ${about.arch}`],
      ['Logs', about.logDir ?? 'unknown'],
    ];
  },

  /** Reads the versions into `$about`, once per window; a failure lets the next call retry. */
  loadAbout() {
    aboutLoading ??= ipc
      .invoke('get_about')
      .then((about) => $about.set(/** @type {AboutInfo} */ (about)))
      .catch((err) => {
        aboutLoading = null;
        app.log('warn', `reading About failed: ${err}`);
      });
    return aboutLoading;
  },

  /**
   * Writes to the app log file. Never throws: a failed write (e.g. `pnpm dev` without Tauri) is
   * dropped, so logging an error can't raise another one.
   * @param {LogLevel} level
   * @param {string} message
   */
  log(level, message) {
    ipc.invoke('write_log', { level, message }).catch(() => {});
  },

  /**
   * Logs a failed action and shows it in a snackbar.
   * @param {string} what What failed, e.g. `Opening folder failed`.
   * @param {unknown} error
   */
  reportError(what, error) {
    const reason = error instanceof Error ? error.message : String(error);
    app.log('warn', `${what}: ${reason}`);
    notify('error', `${what}: ${reason}`);
  },

  /**
   * Clicks on the app's own menu bar items (macOS), sent to the focused window.
   * @param {(id: MenuAction) => void} callback
   * @returns {Promise<() => void>} Stops listening.
   */
  onMenuAction(callback) {
    return ipc.listen('menu://action', callback);
  },

  /**
   * Opens a web or mail link in the default app.
   * @param {string} url `http(s):` or `mailto:`; anything else is refused.
   * @returns {Promise<void>}
   */
  openUrl(url) {
    return ipc.invoke('open_url', { url });
  },

  /**
   * Copies text to the clipboard; a failure shows a snackbar.
   * @param {string} text
   * @param {string} what What failed if it can't, e.g. `Copying the path failed`.
   */
  copy(text, what) {
    navigator.clipboard.writeText(text).catch((err) => app.reportError(what, err));
  },

  /**
   * Starts what the app does for the whole window: logging uncaught errors and unhandled
   * rejections (and showing them; the release build has no console), and showing the backend's own
   * warnings and errors, which it has logged already.
   */
  init() {
    window.addEventListener('error', (e) => {
      const stack = e.error instanceof Error ? describe(e.error) : e.message;
      app.log('error', `uncaught ${stack} (${e.filename}:${e.lineno}:${e.colno})`);
      // Errors without an Error object are browser notices, e.g. "ResizeObserver loop completed".
      if (e.error instanceof Error) notify('error', e.error.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
      app.log('error', `unhandled rejection ${describe(e.reason)}`);
      notify('error', e.reason instanceof Error ? e.reason.message : String(e.reason));
    });
    ipc
      .listen('app://notice', (/** @type {{ level: NoticeLevel, message: string }} */ { level, message }) => notify(level, message))
      .catch((err) => app.log('warn', `backend notices unavailable: ${err}`));
  },
});
