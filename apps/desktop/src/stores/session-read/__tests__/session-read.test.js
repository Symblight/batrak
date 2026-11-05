import { expect } from '@esm-bundle/chai';
import {
  $readBaselines,
  $sessionReads,
  $unreadSessions,
  forgetRead,
  markProjectRead,
  markRead,
  markSeen,
  markUnread,
  parseSessionRead,
  recordBaselines,
} from '../session-read.js';
import { persistentMapStore } from '../../persistent/persistent.js';
import { $sessions } from '../../sessions/sessions.js';

/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../../hooks/sessions/types.js').SyncOutcome} SyncOutcome */

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {string} id
 * @param {Partial<Session>} [rest]
 * @returns {Session}
 */
function session(id, rest = {}) {
  return /** @type {Session} */ ({ id, projectId: '/p', agentId: 'claude', status: 'idle', title: id, lastActivityAt: iso(T0), ...rest });
}

/**
 * @param {string} endedAt
 * @param {Record<string, SyncOutcome>} agents
 */
function report(endedAt, agents) {
  return {
    projectPath: '/p',
    startedAt: endedAt,
    endedAt,
    agents: Object.entries(agents).map(([agentId, outcome]) => ({ agentId, agentName: agentId, outcome, count: null, error: null })),
  };
}

/** @returns {string[]} */
const unread = () => [...$unreadSessions.get()].sort();

describe('session-read', () => {
  /** @type {() => void} */
  let stop;
  beforeEach(() => {
    stop = $unreadSessions.listen(() => {});
  });
  afterEach(() => {
    stop();
    for (const id of Object.keys($sessionReads.get())) forgetRead(id);
    for (const key of Object.keys($readBaselines.get())) $readBaselines.setKey(key, undefined);
    $sessions.set([]);
  });

  it('marks a session read, unread, or a whole project read, and seen replaces a hand mark', () => {
    $sessions.set([
      session('a', { lastActivityAt: iso(T0 + 60_000) }),
      session('b', { lastActivityAt: iso(T0 + 60_000), status: 'working' }),
      session('c', { lastActivityAt: iso(T0 + 60_000) }),
      session('other', { projectId: '/q', lastActivityAt: iso(T0 + 60_000) }),
    ]);
    for (const id of ['a', 'b', 'c', 'other']) $sessionReads.setKey(id, { seen: iso(T0) });
    expect(unread()).to.deep.equal(['a', 'b', 'c', 'other']);

    markRead('a', T0 + 61_000);
    expect($sessionReads.get().a).to.deep.equal({ seen: iso(T0 + 61_000) });
    expect(unread()).to.deep.equal(['b', 'c', 'other']);

    markUnread('a');
    expect($sessionReads.get().a).to.deep.equal({ seen: null });
    expect(unread()).to.deep.equal(['a', 'b', 'c', 'other']);

    markSeen('a', T0 + 62_000);
    expect($sessionReads.get().a, 'seen replaces the hand mark').to.deep.equal({ seen: iso(T0 + 62_000) });

    markUnread('a');
    markProjectRead('/p', T0 + 63_000);
    expect(unread(), 'the hand-marked and the running too, not another project').to.deep.equal(['other']);
  });

  it('writes nothing when it would change nothing', () => {
    $sessions.set([session('a', { lastActivityAt: iso(T0 + 60_000) }), session('b')]);
    $sessionReads.setKey('a', { seen: iso(T0) });
    $sessionReads.setKey('b', { seen: iso(T0) });
    let writes = 0;
    const off = $sessionReads.listen(() => writes++);

    markSeen('a', T0 + 61_000);
    markSeen('a', T0 + 61_500);
    expect(writes, 'seen again within the second').to.equal(1);
    markSeen('a', T0 + 62_100);
    expect(writes, 'a second on').to.equal(2);

    markRead('b', T0 + 1_000);
    markProjectRead('/p', T0 + 62_200);
    expect(writes, 'already read').to.equal(2);

    markUnread('a');
    markUnread('a');
    expect(writes, 'already marked unread').to.equal(3);

    markSeen('gone', T0);
    markRead('gone', T0);
    markUnread('gone');
    forgetRead('gone');
    expect(writes, 'not a listed session').to.equal(3);

    forgetRead('b');
    expect($sessionReads.get().b).to.equal(undefined);
    off();
  });

  it('follows a session\'s activity: output, a turn end, a failure and a sync bump, but not the agent\'s trailing writes', () => {
    $sessions.set([session('a')]);
    markSeen('a', T0);
    expect(unread()).to.deep.equal([]);

    $sessions.set([session('a', { lastActivityAt: iso(T0 + 3_000) })]);
    expect(unread(), 'within the slack').to.deep.equal([]);
    $sessions.set([session('a', { status: 'working', lastActivityAt: iso(T0 + 8_000) })]);
    expect(unread(), 'output').to.deep.equal(['a']);

    markSeen('a', T0 + 9_000);
    $sessions.set([session('a', { status: 'idle', lastActivityAt: iso(T0 + 20_000) })]);
    expect(unread(), 'a turn end').to.deep.equal(['a']);

    markSeen('a', T0 + 21_000);
    $sessions.set([session('a', { status: 'error', lastActivityAt: iso(T0 + 40_000) })]);
    expect(unread(), 'a failed turn').to.deep.equal(['a']);

    markSeen('a', T0 + 41_000);
    $sessions.set([session('a', { status: 'stopped', lastActivityAt: iso(T0 + 300_000) })]);
    expect(unread(), 'a sync that found newer work').to.deep.equal(['a']);
  });

  it('keeps the same list while other fields of the sessions change', () => {
    $sessions.set([session('a')]);
    markUnread('a');
    const first = $unreadSessions.get();
    $sessions.set([session('a', { status: 'working' })]);
    expect($unreadSessions.get()).to.equal(first);
  });

  it('reads a session never seen against its agent\'s baseline, written once, by the first window', () => {
    $sessions.set([
      session('old', { lastActivityAt: iso(T0 - 3_600_000) }),
      session('new', { lastActivityAt: iso(T0 + 60_000) }),
      session('mute', { agentId: 'mute', lastActivityAt: iso(T0 + 60_000) }),
    ]);
    expect(unread(), 'no baseline: read').to.deep.equal([]);

    recordBaselines(report(iso(T0), { claude: 'listed', mute: 'unsupported', failing: 'failed' }));
    expect($readBaselines.get()).to.deep.equal({ 'claude\n/p': iso(T0) });
    expect(unread()).to.deep.equal(['new']);

    recordBaselines(report(iso(T0 + 120_000), { claude: 'listed' }));
    expect($readBaselines.get()['claude\n/p'], 'the first one stays').to.equal(iso(T0));

    // Another window wrote one this window has not heard of yet.
    localStorage.setItem('batrak:sessions:baseline:codex\n/p', JSON.stringify(iso(T0)));
    recordBaselines(report(iso(T0 + 120_000), { codex: 'listed' }));
    expect(localStorage.getItem('batrak:sessions:baseline:codex\n/p')).to.equal(JSON.stringify(iso(T0)));
    localStorage.removeItem('batrak:sessions:baseline:codex\n/p');

    // A stored value that isn't a time doesn't hold the place of a baseline.
    localStorage.setItem('batrak:sessions:baseline:gemini\n/p', JSON.stringify('yesterday'));
    recordBaselines(report(iso(T0), { gemini: 'listed' }));
    expect(localStorage.getItem('batrak:sessions:baseline:gemini\n/p')).to.equal(JSON.stringify(iso(T0)));
    localStorage.removeItem('batrak:sessions:baseline:gemini\n/p');
  });

  it('keeps marks across a reload, and follows the other windows\' marks', () => {
    $sessions.set([session('a', { lastActivityAt: iso(T0 + 60_000) })]);
    markSeen('a', T0);
    const reloaded = persistentMapStore('batrak:sessions:read:', parseSessionRead);
    expect(reloaded.get()).to.deep.equal({ a: { seen: iso(T0) } });
    expect(unread()).to.deep.equal(['a']);

    window.dispatchEvent(new StorageEvent('storage', { key: 'batrak:sessions:read:a', newValue: JSON.stringify({ seen: iso(T0 + 60_000) }) }));
    expect(unread(), 'read in another window').to.deep.equal([]);
    window.dispatchEvent(new StorageEvent('storage', { key: 'batrak:sessions:read:a', newValue: JSON.stringify({ seen: null }) }));
    expect(unread(), 'marked unread in another window').to.deep.equal(['a']);

    expect(parseSessionRead({ seen: 'yesterday' }), 'not a time').to.equal(null);
    expect(parseSessionRead({})).to.equal(null);
    expect(parseSessionRead({ seen: null })).to.deep.equal({ seen: null });
  });
});
