import { writeLog } from './ipc.js';

/** @typedef {import('../models/types.js').LogLevel} LogLevel */

/**
 * Writes to the app log file. Never throws: a failed write (e.g. `pnpm dev` without Tauri) is dropped,
 * so logging an error can't raise another one.
 * @param {LogLevel} level
 * @param {string} message
 */
export function log(level, message) {
  writeLog(level, message).catch(() => {});
}

/**
 * Message and stack of whatever was thrown.
 * @param {unknown} error
 */
function describe(error) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Logs uncaught errors and unhandled promise rejections; the release build has no console to show them. */
export function logUncaughtErrors() {
  window.addEventListener('error', (e) => {
    const stack = e.error instanceof Error ? describe(e.error) : e.message;
    log('error', `uncaught ${stack} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    log('error', `unhandled rejection ${describe(e.reason)}`);
  });
}
