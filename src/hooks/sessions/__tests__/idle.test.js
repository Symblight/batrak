import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cancelIdleStop, stopWhenIdle } from '../idle.js';
import { $activeSessionId, $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../types.js').Session} Session */

/** The clock the module sees: timers are kept here, fired by the test. */
function fakeClock() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const timers = new Map();
  let next = 1000;
  globalThis.setTimeout = /** @type {never} */ ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    if (ms !== 10 * 60_000) return realSet(fn, ms);
    timers.set(next, { fn, ms });
    return next++;
  });
  globalThis.clearTimeout = /** @type {never} */ ((/** @type {number} */ id) => {
    if (timers.delete(id)) return;
    realClear(id);
  });
  return {
    timers,
    fire() {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.fn();
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

describe('idle stop', () => {
  /** @type {string[]} */
  let stops;
  /** @type {ReturnType<typeof fakeClock>} */
  let clock;

  beforeEach(() => {
    stops = [];
    mockIPC((cmd, args) => {
      if (cmd === 'session_stop') stops.push(/** @type {{ sessionId: string }} */ (args).sessionId);
      return null;
    });
    clock = fakeClock();
  });

  afterEach(() => {
    cancelIdleStop('s1');
    clock.restore();
    $sessions.set([]);
    $activeSessionId.set(null);
    clearMocks();
  });

  /** @param {string} status */
  const sessions = (status) => $sessions.set([/** @type {Session} */ ({ id: 's1', status })]);

  it('stops a hidden session’s idle agent after ten minutes', async () => {
    sessions('idle');
    stopWhenIdle('s1');
    expect(clock.timers.size).to.equal(1);
    clock.fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).to.deep.equal(['s1']);
    expect(clock.timers.size, 'nothing left to wait for').to.equal(0);
  });

  it('leaves the session alone when it was shown again, is stopped or failed, and tries again later while it is busy', () => {
    /** @type {[string, string | null, number][]} */
    const cases = [
      ['idle', 's1', 0], // shown again
      ['stopped', null, 0],
      ['error', null, 0],
      ['working', null, 1], // busy: asked again after another ten minutes
      ['waiting', null, 1],
    ];
    for (const [status, active, rescheduled] of cases) {
      sessions(status);
      $activeSessionId.set(active);
      stopWhenIdle('s1');
      clock.fire();
      expect(stops, `${status}${active ? ' (shown)' : ''}`).to.deep.equal([]);
      expect(clock.timers.size, `${status}: rescheduled`).to.equal(rescheduled);
      cancelIdleStop('s1');
    }
  });

  it('keeps one timer per session, and cancelIdleStop calls it off', () => {
    sessions('idle');
    stopWhenIdle('s1');
    stopWhenIdle('s1');
    expect(clock.timers.size, 'the second replaces the first').to.equal(1);
    cancelIdleStop('s1');
    expect(clock.timers.size).to.equal(0);
    cancelIdleStop('s1');
    expect(clock.timers.size, 'cancelling twice is harmless').to.equal(0);
  });
});
