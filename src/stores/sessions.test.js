import { expect } from '@esm-bundle/chai';
import { $pinnedSessions, $sessions, newSession, removeSession, setSessionPinned, startSession, touchSession } from './sessions.js';

describe('sessions', () => {
  afterEach(() => {
    $sessions.set([]);
    $pinnedSessions.set([]);
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
