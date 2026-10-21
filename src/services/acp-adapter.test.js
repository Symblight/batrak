import { expect } from '@esm-bundle/chai';
import { handleSessionEvent } from './acp-adapter.js';
import { $sessions, newSession, startSession } from '../stores/sessions.js';
import { $sessionNotices, dismissSessionNotice } from '../stores/session-runtime.js';
import { $awaitingTrust } from '../stores/trust.js';
import { $contextUsage, forgetContextUsage } from '../stores/context-usage.js';

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

  it('says which session a queued turn waits for until the turn starts', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'status', payload: { status: 'queued' } });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'queued', payload: { holder: { id: 'a', title: 'Fix the tree' } } });
    const notice = { kind: 'queued', message: 'Waiting for "Fix the tree" to finish', holder: { id: 'a', title: 'Fix the tree' } };
    expect($sessionNotices.get()[id]).to.deep.equal(notice);
    expect($sessions.get()[0].status).to.equal('queued');
    handleSessionEvent({ sessionId: id, seq: 3, kind: 'status', payload: { status: 'queued' } });
    expect($sessionNotices.get()[id], 'while it waits').to.deep.equal(notice);
    handleSessionEvent({ sessionId: id, seq: 4, kind: 'queued', payload: { holder: { id: 'b', title: null } } });
    expect($sessionNotices.get()[id]?.message, 'a holder without a title').to.equal('Waiting for another session to finish');
    handleSessionEvent({ sessionId: id, seq: 5, kind: 'status', payload: { status: 'working' } });
    expect($sessionNotices.get()[id] ?? null).to.equal(null);
  });

  it('warns that another running turn changed the same file until the turn ends', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'status', payload: { status: 'working' } });
    handleSessionEvent({ sessionId: id, seq: 3, kind: 'overlap', payload: { path: 'src/a.js', other: { id: 'b', title: 'Fix the tree' } } });
    expect($sessionNotices.get()[id]).to.deep.equal({ kind: 'overlap', message: 'src/a.js was also changed by "Fix the tree"' });
    handleSessionEvent({ sessionId: id, seq: 4, kind: 'status', payload: { status: 'waiting' } });
    handleSessionEvent({ sessionId: id, seq: 5, kind: 'status', payload: { status: 'working' } });
    expect($sessionNotices.get()[id]?.kind, 'through the turn').to.equal('overlap');
    handleSessionEvent({ sessionId: id, seq: 6, kind: 'turn-end', payload: { stopReason: 'end_turn' } });
    expect($sessionNotices.get()[id] ?? null).to.equal(null);
  });

  it('puts back the notice an overlap covered once the turn ends', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
    const outdated = { kind: 'outdated', message: 'agents.json changed what Fake runs. Restart to use it.' };
    const overlap = { path: 'src/a.js', other: { id: 'b', title: 'Fix the tree' } };
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'agent-outdated', payload: { message: outdated.message } });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 3, kind: 'overlap', payload: overlap });
    expect($sessionNotices.get()[id]?.kind).to.equal('overlap');
    handleSessionEvent({ sessionId: id, seq: 4, kind: 'turn-end', payload: { stopReason: 'end_turn' } });
    expect($sessionNotices.get()[id]).to.deep.equal(outdated);

    handleSessionEvent({ sessionId: id, seq: 5, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 6, kind: 'overlap', payload: overlap });
    handleSessionEvent({ sessionId: id, seq: 7, kind: 'agent-outdated', payload: { message: null } });
    expect($sessionNotices.get()[id]?.kind, 'the overlap stays').to.equal('overlap');
    handleSessionEvent({ sessionId: id, seq: 8, kind: 'turn-end', payload: { stopReason: 'end_turn' } });
    expect($sessionNotices.get()[id] ?? null, 'changed back meanwhile').to.equal(null);

    handleSessionEvent({ sessionId: id, seq: 9, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 10, kind: 'overlap', payload: overlap });
    handleSessionEvent({ sessionId: id, seq: 11, kind: 'agent-outdated', payload: { message: outdated.message } });
    expect($sessionNotices.get()[id]?.kind, 'the overlap stays').to.equal('overlap');
    dismissSessionNotice(id);
    expect($sessionNotices.get()[id], 'dismissed, what it covered').to.deep.equal(outdated);
  });

  it("keeps a running session's context usage, without its cost", () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'claude', config: {}, mode: 'local' });
    const cost = { amount: 0.04, currency: 'USD' };
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'update', payload: { sessionUpdate: 'usage_update', used: 24000, size: 200000, cost } });
    expect($contextUsage.get()[id]).to.deep.equal({ used: 24000, size: 200000 });
    forgetContextUsage(id);
  });
});
