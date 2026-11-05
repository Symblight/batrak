import { atom, onMount } from 'nanostores';

/** How often `$now` ticks. */
const TICK_MS = 10_000;

/** The time, ms, ticking every 10 s while anyone listens: what expires on its own (a session active elsewhere) re-renders. */
export const $now = atom(Date.now());

onMount($now, () => {
  $now.set(Date.now());
  const timer = setInterval(() => $now.set(Date.now()), TICK_MS);
  return () => clearInterval(timer);
});
