import { expect } from '@esm-bundle/chai';
import {
  $activeSessionId,
  $localShared,
  $pinnedSessions,
  $sessions,
  newSession,
  removeSession,
  setSessionPinned,
  setSessionStatus,
  startSession,
  touchSession,
} from './sessions.js';

describe('sessions', () => {
  afterEach(() => {
    $sessions.set([]);
    $pinnedSessions.set([]);
    $activeSessionId.set(null);
  });

  it("counts the other local sessions running in the active session's project", () => {
    /** @param {string} project @param {'local' | 'worktree'} mode @param {import('../models/types.js').SessionStatus} status */
    const add = (project, mode, status) => {
      const id = newSession(project);
      startSession(id, { title: 'T', agentId: 'a', config: {}, mode });
      setSessionStatus(id, status);
      return id;
    };
    add('/p', 'local', 'working');
    add('/p', 'local', 'idle');
    add('/p', 'local', 'stopped');
    add('/p', 'worktree', 'working');
    add('/q', 'local', 'working');
    const draft = newSession('/p');
    $activeSessionId.set(draft);
    expect($localShared.get(), 'from a draft').to.equal(2);
    $activeSessionId.set(add('/p', 'local', 'queued'));
    expect($localShared.get(), 'not counting itself').to.equal(2);
  });

  it('starts a session active as of its creation', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    const [session] = $sessions.get();
    expect(session.lastActivityAt).to.equal(session.createdAt);
    expect([session.titleSource, session.agentTitle]).to.deep.equal(['prompt', null]);
  });

  it('marks a session active now', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    touchSession(id, '2099-01-01T00:00:00.000Z');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T00:00:00.000Z');
  });

  it('pins and unpins a session, and forgets the pin of a removed one', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    setSessionPinned(id, true);
    setSessionPinned(id, true);
    expect($pinnedSessions.get()).to.deep.equal([id]);
    setSessionPinned(id, false);
    expect($pinnedSessions.get()).to.deep.equal([]);

    setSessionPinned(id, true);
    removeSession(id);
    expect($pinnedSessions.get()).to.deep.equal([]);
  });
});
