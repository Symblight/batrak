import { expect } from '@esm-bundle/chai';
import { trackSeen } from '../seen.js';
import { handleSessionEvent } from '../adapter.js';
import { $hiddenColumns } from '../../../stores/layout/layout.js';
import { $sessionReads, $unreadSessions, forgetRead, markUnread } from '../../../stores/session-read/session-read.js';
import { $activeSessionId, $sessions, touchSession } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../types.js').Session} Session */

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** @param {string} id */
function session(id) {
  return /** @type {Session} */ ({ id, projectId: '/p', agentId: 'claude', status: 'idle', title: id, lastActivityAt: iso(T0) });
}

describe('seen tracking', () => {
  const realNow = Date.now;
  let clock = T0;
  let visible = true;
  let focused = true;
  /** @type {() => void} */
  let stop = () => {};
  /** @type {() => void} */
  let unlisten = () => {};

  /** @returns {string | null | undefined} */
  const mark = (/** @type {string} */ id) => $sessionReads.get()[id]?.seen;
  const unread = () => [...$unreadSessions.get()].sort();
  const focus = (/** @type {boolean} */ on) => {
    focused = on;
    window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
  };
  const show = (/** @type {boolean} */ on) => {
    visible = on;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  /** @param {number} ms Time passes, and the backend stamps output at it. */
  const output = (ms, id = 's1') => {
    clock = T0 + ms;
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'activity', payload: { at: iso(clock) } });
  };

  beforeEach(() => {
    clock = T0;
    visible = true;
    focused = true;
    Date.now = () => clock;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    unlisten = $unreadSessions.listen(() => {});
    $sessions.set([session('s1'), session('s2')]);
    $activeSessionId.set('s1');
  });

  afterEach(() => {
    stop();
    unlisten();
    Date.now = realNow;
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(document, 'hasFocus');
    $hiddenColumns.set([]);
    $activeSessionId.set(null);
    for (const id of Object.keys($sessionReads.get())) forgetRead(id);
    $sessions.set([]);
  });

  it('marks the shown session seen only while the page is visible, the window focused and the agent column shown', () => {
    focused = false;
    stop = trackSeen();
    expect(mark('s1'), 'not focused').to.equal(undefined);

    clock = T0 + 1000;
    focus(true);
    expect(mark('s1'), 'catches up on focus').to.equal(iso(T0 + 1000));

    forgetRead('s1');
    show(false);
    clock = T0 + 2000;
    show(true);
    expect(mark('s1'), 'visible again').to.equal(iso(T0 + 2000));

    focus(false);
    forgetRead('s1');
    $hiddenColumns.set(['agent']);
    focus(true);
    expect(mark('s1'), 'column hidden').to.equal(undefined);
    clock = T0 + 3000;
    $hiddenColumns.set([]);
    expect(mark('s1'), 'column shown again').to.equal(iso(T0 + 3000));
  });

  it('writes a last stamp when the session stops being seen: another one shown, the window blurred', () => {
    stop = trackSeen();
    expect(mark('s1')).to.equal(iso(T0));
    clock = T0 + 2000;
    $activeSessionId.set('s2');
    expect(mark('s1'), 'another session shown').to.equal(iso(T0 + 2000));
    expect(mark('s2'), 'and it is seen').to.equal(iso(T0 + 2000));
    clock = T0 + 4000;
    focus(false);
    expect(mark('s2'), 'blurred').to.equal(iso(T0 + 4000));
    expect(mark('s1'), 'not seen any more: untouched').to.equal(iso(T0 + 2000));
  });

  it('leaves output in the shown session read, and makes output in another session or in a blurred window unread', () => {
    $sessionReads.setKey('s2', { seen: iso(T0) });
    stop = trackSeen();
    output(10_000);
    output(10_000, 's2');
    expect(unread(), 'the shown one stays read').to.deep.equal(['s2']);

    focus(false);
    output(20_000);
    expect(unread()).to.deep.equal(['s1', 's2']);
    clock = T0 + 21_000;
    focus(true);
    expect(unread(), 'until the window gets focus').to.deep.equal(['s2']);
  });

  it('keeps a hand mark on another session until it is shown and seen, and replaces one on the shown session at once', () => {
    stop = trackSeen();
    markUnread('s2');
    output(10_000);
    expect(unread()).to.deep.equal(['s2']);
    clock = T0 + 20_000;
    $activeSessionId.set('s2');
    expect(unread(), 'shown and seen').to.deep.equal([]);

    // Marked unread in another window, which shows the session too.
    clock = T0 + 30_000;
    window.dispatchEvent(new StorageEvent('storage', { key: 'batrak:sessions:read:s2', newValue: JSON.stringify({ seen: null }) }));
    expect(mark('s2')).to.equal(iso(T0 + 30_000));
    expect(unread()).to.deep.equal([]);
  });

  it('settles after one write: stamps arriving within a second do not write the mark again', () => {
    let writes = 0;
    const stopCounting = $sessionReads.listen(() => writes++);
    try {
      stop = trackSeen();
      expect(writes, 'when it becomes seen').to.equal(1);
      for (let i = 1; i <= 3; i++) touchSession('s1', iso(T0 + i));
      focus(true);
      expect(writes).to.equal(1);
      clock = T0 + 1500;
      touchSession('s1', iso(T0 + 1500));
      expect(writes, 'a second later, once').to.equal(2);
    } finally {
      stopCounting();
    }
  });
});
