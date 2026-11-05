import { actions } from './actions.js';
import { $activeSessionId, $sessions } from '../../stores/sessions/sessions.js';

/** How long a hidden session's agent may sit idle before it's stopped (showing it resumes it). */
const IDLE_STOP_MS = 10 * 60_000;

/** @type {Map<string, ReturnType<typeof setTimeout>>} Hidden sessions whose agent stops once idle. */
const idleStops = new Map();

/**
 * A session is wanted again (shown, its CLI starting, removed): its idle stop is called off.
 * @param {string} id
 */
export function cancelIdleStop(id) {
  clearTimeout(idleStops.get(id));
  idleStops.delete(id);
}

/**
 * Stops a hidden session's agent after `IDLE_STOP_MS`, or later if it's busy then.
 * @param {string} id
 */
export function stopWhenIdle(id) {
  clearTimeout(idleStops.get(id));
  const timer = setTimeout(() => {
    idleStops.delete(id);
    if ($activeSessionId.get() === id) return;
    const status = $sessions.get().find((s) => s.id === id)?.status;
    if (status === 'idle') actions.stop(id);
    else if (status !== undefined && status !== 'stopped' && status !== 'error') stopWhenIdle(id);
  }, IDLE_STOP_MS);
  idleStops.set(id, timer);
}
