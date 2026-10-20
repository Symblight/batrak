import { expect } from '@esm-bundle/chai';
import { handleSessionEvent } from './acp-adapter.js';
import { $sessions, newSession, startSession } from '../stores/sessions.js';
import { $sessionNotices } from '../stores/session-runtime.js';
import { $awaitingTrust } from '../stores/trust.js';

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

  it('asks for trust when the project agent was refused, keeping the error in the chat', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'repo', config: {}, mode: 'local' });
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'status', payload: { status: 'error', message: 'Not trusted' } });
    const launch = { agentId: 'repo', command: './run', args: [], env: {}, mcpServers: [] };
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'untrusted', payload: { launch, message: 'Not trusted' } });
    expect($awaitingTrust.get()).to.deep.equal([id]);
    expect($sessionNotices.get()[id]).to.include({ kind: 'error', message: 'Not trusted' });
    $awaitingTrust.set([]);
  });
});
