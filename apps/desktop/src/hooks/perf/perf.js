import { app } from '../app/app.js';

/**
 * @typedef {object} Stall
 * @property {number} gap Milliseconds between two frames.
 * @property {number} at When the late frame ran (`performance.now()` scale).
 */

/** A frame later than this (ms) after the one before means the main thread was blocked. */
const STALL_MS = 50;

/**
 * Measuring the main thread: the Long Tasks API is missing in Safari's engine (the macOS WebView), so
 * a stall is a gap between animation frames, which every engine has.
 */
export const perf = Object.freeze({
  /**
   * Calls `onStall` for each gap between frames over `threshold`. A hidden window gets no frames, so
   * the gap across it isn't counted.
   * @param {object} options
   * @param {number} [options.threshold]
   * @param {(stall: Stall) => void} options.onStall
   * @param {(callback: (time: number) => void) => number} [options.requestFrame]
   * @param {(handle: number) => void} [options.cancelFrame]
   * @param {() => boolean} [options.isVisible]
   * @returns {() => void} Stops watching.
   */
  watchStalls({
    threshold = STALL_MS,
    onStall,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
    isVisible = () => document.visibilityState === 'visible',
  }) {
    /** @type {number | null} */
    let last = null;
    let handle = 0;
    const tick = (/** @type {number} */ time) => {
      if (!isVisible()) last = null;
      else {
        if (last !== null && time - last > threshold) onStall({ gap: time - last, at: time });
        last = time;
      }
      handle = requestFrame(tick);
    };
    handle = requestFrame(tick);
    return () => cancelFrame(handle);
  },

  /** Logs every stall to the app log at `info`: seen in dev builds, in a release build with `BRAMA_LOG=info`. */
  start() {
    return perf.watchStalls({
      onStall: ({ gap }) => app.log('info', `main thread blocked for ${Math.round(gap)} ms`),
    });
  },
});
