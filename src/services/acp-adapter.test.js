import { expect } from '@esm-bundle/chai';
import { handleSessionEvent } from './acp-adapter.js';
import { $sessions, newSession, startSession } from '../stores/sessions.js';

describe('acp-adapter', () => {
  afterEach(() => $sessions.set([]));

  it('takes the session the agent named as the backend reports it', () => {
    const id = newSession('/p');
    startSession(id, { title: 'Analyze the tree', agentId: 'a', config: {}, mode: 'local' });
    /** @type {import('../models/types.js').Session} */
    const named = { ...$sessions.get()[0], title: 'Tree view gaps', titleSource: 'agent', agentTitle: 'Tree view gaps' };
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'session', payload: named });
    expect($sessions.get()[0]).to.include({ title: 'Tree view gaps', titleSource: 'agent', agentTitle: 'Tree view gaps' });
  });
});
