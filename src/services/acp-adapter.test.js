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

  it('shows why a session stopped when agents.json lost its agent', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'claude', config: {}, mode: 'local' });
    const message = 'Agent "claude" is no longer configured';
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'status', payload: { status: 'error', message } });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'unconfigured', payload: { agentId: 'claude', message, ran: 'npx -y x' } });
    expect($sessionNotices.get()[id]).to.include({ kind: 'error', message });
  });

  it('keeps the notice that agents.json changed the running agent until it is restarted or changed back', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
    const message = 'agents.json changed what Fake runs. Restart to use it.';
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'agent-outdated', payload: { message } });
    expect($sessionNotices.get()[id]).to.deep.equal({ kind: 'outdated', message });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'status', payload: { status: 'working' } });
    handleSessionEvent({ sessionId: id, seq: 3, kind: 'status', payload: { status: 'idle' } });
    expect($sessionNotices.get()[id]?.kind, 'through its turns').to.equal('outdated');
    handleSessionEvent({ sessionId: id, seq: 4, kind: 'agent-outdated', payload: { message: null } });
    expect($sessionNotices.get()[id] ?? null).to.equal(null);

    handleSessionEvent({ sessionId: id, seq: 5, kind: 'agent-outdated', payload: { message } });
    handleSessionEvent({ sessionId: id, seq: 6, kind: 'status', payload: { status: 'starting' } });
    expect($sessionNotices.get()[id]?.kind, 'a restart replaces it').to.equal('progress');
  });
});
