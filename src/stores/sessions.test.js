import { expect } from '@esm-bundle/chai';
import { $sessions, newSession, startSession, touchSession } from './sessions.js';

describe('sessions', () => {
  afterEach(() => $sessions.set([]));

  it('starts a session active as of its creation', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    const [session] = $sessions.get();
    expect(session.lastActivityAt).to.equal(session.createdAt);
  });

  it('marks a session active now', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    touchSession(id, '2099-01-01T00:00:00.000Z');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T00:00:00.000Z');
  });
});
