import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { USER_ID, acpAdapter, forgetHistory, forgetSession, handleSessionEvent } from '../adapter.js';
import { $terminals, addSessionTerminal } from '../../../stores/terminals/terminals.js';
import { $returnedPrompts, takeReturnedPrompt } from '../../../stores/chat/chat.js';
import { $sessions, newSession, startSession } from '../../../stores/sessions/sessions.js';
import { $permissionRequests, $sessionNotices, $subagents, clearPermissionRequests, dismissSessionNotice } from '../../../stores/session-runtime/session-runtime.js';
import { subagentConversationId } from '../rules.js';
import { $awaitingTrust } from '../../../stores/trust/trust.js';
import { $sessionReads, $unreadSessions, forgetRead } from '../../../stores/session-read/session-read.js';
import { $contextUsage, forgetContextUsage } from '../../../stores/context-usage/context-usage.js';

/** A backend stamp. */
const AT = '2026-10-20T10:00:00.000Z';

describe('acp-adapter', () => {
  afterEach(() => $sessions.set([]));

  it("shows a session's history as its agent replays it, once: a later load (after an idle stop) adds nothing", () => {
    /** @type {{ authorId?: string, delta?: { text?: string } }[]} */
    const chunks = [];
    const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
    try {
      const id = 'replayed';
      let seq = 0;
      const send = (/** @type {string} */ kind, /** @type {unknown} */ payload) =>
        handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: id, seq: ++seq, kind, payload }));
      const load = () => {
        send('status', { status: 'starting' });
        send('update', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'From a terminal' } });
        send('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Its answer' } });
        send('status', { status: 'idle' });
      };
      load();
      const texts = chunks.map((c) => c.delta?.text).filter(Boolean);
      expect(texts).to.deep.equal(['From a terminal', 'Its answer']);
      expect(chunks.find((c) => c.delta?.text === 'From a terminal')?.authorId).to.equal(USER_ID);
      const shown = chunks.length;
      load();
      expect(chunks.length, 'not repeated').to.equal(shown);
    } finally {
      unsubscribe?.();
    }
  });

  it("shows a running session's conversation to a page that attaches: once, and mid-turn with the rest of the turn", () => {
    const text = (/** @type {string} */ kind, /** @type {string} */ t) => ({ sessionUpdate: kind, content: { type: 'text', text: t } });
    const cases = [
      {
        name: 'idle, attached twice',
        // Arrange
        events: [
          ['snapshot', { updates: [text('user_message_chunk', 'Question'), text('agent_message_chunk', 'Answer')] }],
          ['status', { status: 'idle' }],
          ['snapshot', { updates: [text('user_message_chunk', 'Question'), text('agent_message_chunk', 'Answer')] }],
          ['status', { status: 'idle' }],
        ],
        shown: ['Question', 'Answer'],
      },
      {
        name: 'mid-turn, past a permission wait',
        events: [
          ['snapshot', { updates: [text('user_message_chunk', 'Count'), text('agent_message_chunk', '1 ')] }],
          ['status', { status: 'working' }],
          ['update', text('agent_message_chunk', '2 ')],
          ['status', { status: 'waiting' }],
          ['update', text('agent_message_chunk', '3')],
          ['turn-end', { stopReason: 'end_turn', at: AT }],
          ['status', { status: 'idle' }],
        ],
        shown: ['Count', '1 ', '2 ', '3'],
      },
    ];
    for (const [n, { name, events, shown }] of cases.entries()) {
      /** @type {{ delta?: { text?: string } }[]} */
      const chunks = [];
      const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
      try {
        // Act
        for (const [seq, [kind, payload]] of events.entries()) {
          handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: `attached-${n}`, seq, kind, payload }));
        }
        // Assert
        expect(chunks.map((c) => c.delta?.text).filter(Boolean), name).to.deep.equal(shown);
      } finally {
        unsubscribe?.();
      }
    }
  });

  it('replays a history again once forgotten: turns a CLI ran since', () => {
    /** @type {{ delta?: { text?: string } }[]} */
    const chunks = [];
    const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
    try {
      const id = 'forgotten';
      let seq = 0;
      const send = (/** @type {string} */ kind, /** @type {unknown} */ payload) =>
        handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: id, seq: ++seq, kind, payload }));
      const load = () => {
        send('status', { status: 'starting' });
        send('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
        send('status', { status: 'idle' });
      };
      load();
      forgetHistory(id);
      load();
      expect(chunks.map((c) => c.delta?.text).filter(Boolean)).to.deep.equal(['Hello', 'Hello']);
    } finally {
      unsubscribe?.();
    }
  });

  it("marks a session's CLI exited", () => {
    addSessionTerminal('t-cli', 'cli-session', '/p', 'Claude Code');
    handleSessionEvent({ sessionId: 'cli-session', seq: 1, kind: 'cli-exited', payload: { code: 0, signal: null } });
    expect($terminals.get()['t-cli']).to.deep.include({ status: 'exited', exit: { code: 0, signal: null } });
    $terminals.set({});
  });

  it('takes the session the agent named as the backend reports it', () => {
    const id = newSession('/p');
    startSession(id, { title: 'Analyze the tree', agentId: 'a', config: {}, mode: 'local' });
    /** @type {import('../types.js').Session} */
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

  it('offers to turn a session\'s agent back on when the user turned it off', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'codex', config: {}, mode: 'local' });
    const message = 'Codex is off';
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'status', payload: { status: 'error', message } });
    handleSessionEvent({ sessionId: id, seq: 2, kind: 'unconfigured', payload: { agentId: 'codex', message, ran: null, reason: 'off' } });
    expect($sessionNotices.get()[id]).to.deep.equal({ kind: 'error', message, offAgent: 'codex' });
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
    handleSessionEvent({ sessionId: id, seq: 6, kind: 'turn-end', payload: { stopReason: 'end_turn', at: AT } });
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
    handleSessionEvent({ sessionId: id, seq: 4, kind: 'turn-end', payload: { stopReason: 'end_turn', at: AT } });
    expect($sessionNotices.get()[id]).to.deep.equal(outdated);

    handleSessionEvent({ sessionId: id, seq: 5, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 6, kind: 'overlap', payload: overlap });
    handleSessionEvent({ sessionId: id, seq: 7, kind: 'agent-outdated', payload: { message: null } });
    expect($sessionNotices.get()[id]?.kind, 'the overlap stays').to.equal('overlap');
    handleSessionEvent({ sessionId: id, seq: 8, kind: 'turn-end', payload: { stopReason: 'end_turn', at: AT } });
    expect($sessionNotices.get()[id] ?? null, 'changed back meanwhile').to.equal(null);

    handleSessionEvent({ sessionId: id, seq: 9, kind: 'turn-start', payload: {} });
    handleSessionEvent({ sessionId: id, seq: 10, kind: 'overlap', payload: overlap });
    handleSessionEvent({ sessionId: id, seq: 11, kind: 'agent-outdated', payload: { message: outdated.message } });
    expect($sessionNotices.get()[id]?.kind, 'the overlap stays').to.equal('overlap');
    dismissSessionNotice(id);
    expect($sessionNotices.get()[id], 'dismissed, what it covered').to.deep.equal(outdated);
  });

  it("stamps a session with the backend's times: prompt sent, output, a turn's end and a failed turn", async () => {
    const stamp = (/** @type {number} */ s) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`;
    mockIPC((cmd) => (cmd === 'session_send_prompt' ? stamp(1) : null));
    try {
      const id = 's-stamps';
      $sessions.set([/** @type {import('../types.js').Session} */ ({ id, projectId: '/p', agentId: 'a', status: 'idle', title: 'T', lastActivityAt: stamp(0) })]);
      const stamped = () => $sessions.get()[0].lastActivityAt;
      let seq = 0;
      const send = (/** @type {string} */ kind, /** @type {unknown} */ payload) =>
        handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: id, seq: ++seq, kind, payload }));
      await acpAdapter.sendMessage?.(
        /** @type {Parameters<NonNullable<typeof acpAdapter.sendMessage>>[0]} */ (
          /** @type {unknown} */ ({ id: 'm', conversationId: id, parts: [{ type: 'text', text: 'hello' }] })
        ),
        { signal: new AbortController().signal },
      );
      expect(stamped(), 'the prompt').to.equal(stamp(1));
      send('activity', { at: stamp(2) });
      expect(stamped(), 'output').to.equal(stamp(2));
      send('activity', { at: stamp(1) });
      expect(stamped(), 'a stamp that arrives late is not newer').to.equal(stamp(2));
      send('turn-end', { stopReason: 'end_turn', at: stamp(3) });
      expect(stamped(), "a turn's end").to.equal(stamp(3));
      send('error', { message: 'The agent crashed', turn: true, at: stamp(4) });
      expect(stamped(), 'a failed turn').to.equal(stamp(4));
      send('error', { message: 'Could not start' });
      expect(stamped(), 'an error outside a turn has no stamp').to.equal(stamp(4));
    } finally {
      clearMocks();
    }
  });

  it("does not mark a session unread at a turn's end: its stamp alone decides", () => {
    const id = 's-turn-end';
    const seen = '2026-10-20T10:00:00.000Z';
    $sessions.set([/** @type {import('../types.js').Session} */ ({ id, projectId: '/p', agentId: 'a', status: 'working', title: 'T', lastActivityAt: seen })]);
    $sessionReads.setKey(id, { seen });
    try {
      handleSessionEvent({ sessionId: id, seq: 1, kind: 'turn-end', payload: { stopReason: 'end_turn', at: '2026-10-20T10:00:01.000Z' } });
      expect($unreadSessions.get(), 'inside the slack of what the user saw').to.deep.equal([]);
      handleSessionEvent({ sessionId: id, seq: 2, kind: 'turn-end', payload: { stopReason: 'end_turn', at: '2026-10-20T10:01:00.000Z' } });
      expect($unreadSessions.get()).to.deep.equal([id]);
    } finally {
      forgetRead(id);
    }
  });

  it("keeps a running session's context usage, without its cost", () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'claude', config: {}, mode: 'local' });
    const cost = { amount: 0.04, currency: 'USD' };
    handleSessionEvent({ sessionId: id, seq: 1, kind: 'update', payload: { sessionUpdate: 'usage_update', used: 24000, size: 200000, cost } });
    expect($contextUsage.get()[id]).to.deep.equal({ used: 24000, size: 200000 });
    forgetContextUsage(id);
  });

  describe('subagents', () => {
    const id = 'parent';
    let seq = 0;
    const send = (/** @type {string} */ kind, /** @type {unknown} */ payload) =>
      handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: id, seq: ++seq, kind, payload }));
    afterEach(() => {
      forgetSession(id);
      forgetContextUsage(id);
    });

    /** @param {Partial<import('../types.js').Subagent>} [fields] */
    const subagent = (fields = {}) => ({ id: 'c1', title: 'Find usages', description: 'Explore', state: /** @type {const} */ ('running'), stopReason: null, cancellable: true, announcedAt: '2026-11-03T10:00:00Z', ...fields });

    it("keeps the session's subagents as the backend lists them; a raw subagent_update shows nothing", () => {
      // Arrange
      /** @type {unknown[]} */
      const chunks = [];
      const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(c), onConnectionChange: () => {} });
      try {
        // Act
        send('subagents', { subagents: [subagent()] });
        send('update', { sessionUpdate: 'subagent_update', sessionId: 'c1', state: { state: 'idle', stopReason: 'end_turn' } });
        // Assert
        expect($subagents.get()[id]).to.deep.equal([subagent()]);
        expect(chunks, 'the backend folds it into its list').to.deep.equal([]);
      } finally {
        unsubscribe?.();
      }
    });

    it("shows a subagent's own updates in its own conversation, never in the chat or its context usage", () => {
      // Arrange
      /** @type {{ conversationId?: string, delta?: { text?: string } }[]} */
      const chunks = [];
      const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
      try {
        // Act
        send('subagents', { subagents: [subagent()] });
        send('update', { sessionUpdate: 'session_message', messageId: 'm1', recipientSessionId: 'c1', content: [{ type: 'text', text: 'Look for md-menu' }], subagentId: 'c1' });
        send('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found' }, subagentId: 'c1' });
        send('update', { sessionUpdate: 'usage_update', used: 10, size: 100, subagentId: 'c1' });
        send('permission-request', { requestId: 'r1', toolCall: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt' }, options: [], subagentId: 'c1' });
        // Assert
        const shown = chunks.filter((c) => c.delta?.text).map((c) => [c.conversationId, c.delta?.text]);
        expect(shown, 'its task first').to.deep.equal([[subagentConversationId(id, 'c1'), 'Look for md-menu'], [subagentConversationId(id, 'c1'), 'found']]);
        expect($contextUsage.get()[id]).to.equal(undefined);
        expect($permissionRequests.get()[id]?.map((r) => r.subagentId)).to.deep.equal(['c1']);
      } finally {
        unsubscribe?.();
      }
    });

    it("routes a running chat's subagents in a snapshot as it does live: their list, card and own conversation", () => {
      // Arrange
      /** @type {{ conversationId?: string, partType?: string, delta?: { text?: string, data?: Record<string, unknown> } }[]} */
      const chunks = [];
      const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
      try {
        // Act: a page attaches mid-run: the backend sends its subagents before the snapshot
        send('subagents', { subagents: [subagent()] });
        send('snapshot', {
          updates: [
            { sessionUpdate: 'session_message', messageId: 'm1', recipientSessionId: 'c1', content: [{ type: 'text', text: 'Look' }] },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found' }, subagentId: 'c1' },
          ],
        });
        // Assert
        expect($subagents.get()[id]?.map((s) => s.id)).to.deep.equal(['c1']);
        const where = chunks.filter((c) => c.delta?.text || c.delta?.data?.subagentId).map((c) => [c.conversationId, c.delta?.text ?? 'card']);
        expect(where).to.deep.equal([[id, 'card'], [subagentConversationId(id, 'c1'), 'found']]);
      } finally {
        unsubscribe?.();
        send('status', { status: 'idle' });
      }
    });

    it('shows the task handed to a subagent as a card in the chat, its status following the subagent', () => {
      // Arrange
      /** @type {{ conversationId?: string, partType?: string, delta?: { label?: string, status?: string, data?: Record<string, unknown> } }[]} */
      const chunks = [];
      const unsubscribe = acpAdapter.subscribe?.({ onMessage: () => {}, onChunk: (c) => chunks.push(/** @type {never} */ (c)), onConnectionChange: () => {} });
      try {
        // Act
        send('subagents', { subagents: [subagent()] });
        send('update', { sessionUpdate: 'session_message', messageId: 'm1', senderSessionId: 'acp-parent', recipientSessionId: 'c1', content: [{ type: 'text', text: 'Look for md-menu' }] });
        send('subagents', { subagents: [subagent({ state: 'idle', stopReason: 'end_turn' })] });
        // Assert
        const cards = chunks.filter((c) => c.conversationId === id && c.partType === 'tool_call').map((c) => c.delta);
        expect(cards.map((d) => [d?.label, d?.status, d?.data?.subagentId])).to.deep.equal([
          ['Explore · Find usages', 'in_progress', 'c1'],
          [undefined, 'completed', 'c1'],
        ]);
      } finally {
        unsubscribe?.();
      }
    });
  });

  describe('signing in', () => {
    /** @type {import('../../agents/types.js').SignInMethod[]} */
    const methods = [{ id: 'browser', name: 'Log in', description: null, kind: 'agent', label: null, apiKey: null }];

    it('shows the agent asking to sign in until a start works', () => {
      const id = newSession('/p');
      startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
      handleSessionEvent({ sessionId: id, seq: 1, kind: 'status', payload: { status: 'error', message: 'Sign in to Fake' } });
      handleSessionEvent({ sessionId: id, seq: 2, kind: 'sign-in', payload: { agentId: 'fake', agentName: 'Fake', methods } });
      expect($sessionNotices.get()[id]).to.deep.equal({
        kind: 'sign-in',
        message: 'Sign in to Fake to continue.',
        signIn: { agentId: 'fake', agentName: 'Fake', methods },
      });
      handleSessionEvent({ sessionId: id, seq: 3, kind: 'sign-in', payload: null });
      expect($sessionNotices.get()[id] ?? null).to.equal(null);
    });

    it('gives a dropped prompt back for the composer', () => {
      const id = newSession('/p');
      handleSessionEvent({ sessionId: id, seq: 1, kind: 'prompt-returned', payload: { prompt: [{ type: 'text', text: 'hello' }] } });
      expect($returnedPrompts.get()[id]).to.equal('hello');
      expect(takeReturnedPrompt(id)).to.equal('hello');
      expect($returnedPrompts.get()[id]).to.equal(undefined);
    });

    it("keeps an agent's history replay after a sign-in out of the held turn's reply", async () => {
      mockIPC(() => null);
      /** @type {unknown[]} */
      const replayed = [];
      const unsubscribe = acpAdapter.subscribe?.({
        onMessage: () => {},
        onChunk: (chunk) => replayed.push(chunk),
        onConnectionChange: () => {},
      });
      try {
        const id = newSession('/p');
        startSession(id, { title: 'T', agentId: 'fake', config: {}, mode: 'local' });
        const stream = await acpAdapter.sendMessage?.(
          /** @type {Parameters<NonNullable<typeof acpAdapter.sendMessage>>[0]} */ (
            /** @type {unknown} */ ({ id: 'm', conversationId: id, parts: [{ type: 'text', text: 'hello' }] })
          ),
          { signal: new AbortController().signal },
        );
        const text = (/** @type {string} */ t) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
        let seq = 0;
        const send = (/** @type {string} */ kind, /** @type {unknown} */ payload) =>
          handleSessionEvent(/** @type {import('../types.js').SessionEnvelope} */ ({ sessionId: id, seq: ++seq, kind, payload }));
        send('turn-start', {});
        send('held', { prompt: [{ type: 'text', text: 'hello' }] });
        send('status', { status: 'starting' });
        send('update', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier' } });
        send('update', text('Earlier answer'));
        send('status', { status: 'idle' });
        send('turn-start', {});
        send('update', text('Hello'));
        send('turn-end', { stopReason: 'end_turn', at: AT });

        const reader = /** @type {ReadableStream} */ (stream).getReader();
        const texts = [];
        for (let read = await reader.read(); !read.done; read = await reader.read()) texts.push(read.value.delta?.text);
        expect(texts.filter(Boolean)).to.deep.equal(['Hello']);
        expect(replayed.length, 'the replay went to the history').to.be.greaterThan(0);
      } finally {
        unsubscribe?.();
        clearMocks();
      }
    });
  });
});
