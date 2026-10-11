import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').Notice} Notice */
/** @typedef {import('../models/types.js').NoticeLevel} NoticeLevel */

/** Shown at once; a newer notice pushes out the oldest. */
const MAX_NOTICES = 4;

/** How long a notice stays, in ms; errors stay until dismissed. */
const TIMEOUTS = /** @type {Record<NoticeLevel, number | null>} */ ({ info: 5000, warn: 8000, error: null });

/** Snackbars, oldest first. */
export const $notices = atom(/** @type {Notice[]} */ ([]));

let nextId = 1;
let paused = false;
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const timers = new Map();

/** @param {Notice} notice */
function schedule(notice) {
  clearTimeout(timers.get(notice.id));
  timers.delete(notice.id);
  const timeout = TIMEOUTS[notice.level];
  if (timeout !== null && !paused) timers.set(notice.id, setTimeout(() => dismissNotice(notice.id), timeout));
}

/**
 * Shows a snackbar. The same message while it's still shown counts up on it and restarts its timer.
 * @param {NoticeLevel} level
 * @param {string} message
 */
export function notify(level, message) {
  const notices = $notices.get();
  const same = notices.find((n) => n.level === level && n.message === message);
  if (same) {
    const bumped = { ...same, count: same.count + 1 };
    $notices.set(notices.map((n) => (n === same ? bumped : n)));
    schedule(bumped);
    return;
  }
  const notice = { id: nextId++, level, message, count: 1 };
  const kept = notices.slice(-(MAX_NOTICES - 1));
  for (const dropped of notices.slice(0, notices.length - kept.length)) {
    clearTimeout(timers.get(dropped.id));
    timers.delete(dropped.id);
  }
  $notices.set([...kept, notice]);
  schedule(notice);
}

/** @param {number} id */
export function dismissNotice(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  $notices.set($notices.get().filter((n) => n.id !== id));
}

/**
 * Holds every notice while the pointer is over them, so one can be read; resuming restarts the timers.
 * @param {boolean} hold
 */
export function holdNotices(hold) {
  paused = hold;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (!hold) for (const notice of $notices.get()) schedule(notice);
}
