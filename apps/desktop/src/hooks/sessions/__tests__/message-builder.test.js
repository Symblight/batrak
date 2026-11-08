import { expect } from '@esm-bundle/chai';
import { MessageBuilder } from '../message-builder.js';
import { $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../types.js').AcpSessionUpdate} AcpSessionUpdate */
/**
 * A chunk as the tests read it.
 * @typedef {Object} Shape
 * @property {string} [kind]
 * @property {string} [partId]
 * @property {string} [partType]
 * @property {string} [messageId]
 * @property {string} [conversationId]
 * @property {string} [authorId]
 * @property {Record<string, unknown> & { text?: string, status?: string, data?: { startedAt?: number, endedAt?: number, steps?: unknown[], folded?: boolean }, locations?: unknown[] }} [delta]
 */

/** @param {unknown} chunk */
const shape = (chunk) => /** @type {Shape} */ (chunk);
/** @param {readonly unknown[]} chunks */
const kinds = (chunks) => chunks.map((c) => shape(c).kind ?? 'chunk');
/** @param {string} kind @param {string} [text] */
const textUpdate = (kind, text = 'x') => /** @type {AcpSessionUpdate} */ ({ sessionUpdate: /** @type {never} */ (kind), content: { type: 'text', text } });
/** @param {Record<string, unknown>} fields */
const update = (fields) => /** @type {AcpSessionUpdate} */ (/** @type {unknown} */ (fields));

describe('MessageBuilder', () => {
  it('grows one part from consecutive text chunks, starts the next after a tool call or plan, and puts the plan in one part', () => {
    const b = new MessageBuilder('s1', 'agent');
    const a1 = shape(b.chunks(textUpdate('agent_message_chunk', 'Hel'))[0]);
    const a2 = shape(b.chunks(textUpdate('agent_message_chunk', 'lo'))[0]);
    expect(a2.partId, 'the same part').to.equal(a1.partId);
    expect(a2.delta?.text).to.equal('lo');
    const tool = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }))[0]);
    const after = shape(b.chunks(textUpdate('agent_message_chunk', 'Done'))[0]);
    expect(after.partId, 'a new part after the tool call').to.not.equal(a1.partId);
    expect([a1.messageId, a1.conversationId, a1.authorId]).to.deep.equal([b.messageId, 's1', 'agent']);
    const plan = shape(b.chunks(update({ sessionUpdate: 'plan', entries: [{ content: 'a' }] }))[0]);
    expect(plan.partId, 'the plan is one part').to.equal(`${b.messageId}-plan`);
    expect(b.chunks(textUpdate('available_commands_update')), 'an update it does not show says nothing').to.deep.equal([]);
  });

  it('keeps each tool call as its row shows it: worded label, command, kind, status, files, failure and edit stats', () => {
    // Arrange
    const b = new MessageBuilder('unknown-session', 'agent');
    const content = [
      { type: 'content', content: { type: 'text', text: 'boom' } },
      { type: 'diff', path: 'a.js', newText: 'x' },
      { type: 'content', content: { type: 'text', text: 'again' } },
    ];
    const updates = [
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls -la', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'ls -la', shownLabel: 'List files', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'ls -la', status: 'failed', content },
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit', kind: 'edit', locations: [{ path: '/p/src/a.js', line: 4 }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', shownDiff: { added: 2, removed: 1, created: false } },
    ];
    // Act
    const last = updates.flatMap((u) => b.chunks(update(u))).at(-1);
    // Assert
    const steps = /** @type {{ call: unknown }[]} */ (shape(last).delta?.data?.steps);
    expect(steps.map((step) => step.call)).to.deep.equal([
        { toolCallId: 't1', label: 'List files', command: 'ls -la', kind: 'execute', status: 'failed', locations: [], error: 'boom\nagain', diff: null, startedAt: null, endedAt: null },
        { toolCallId: 't2', label: 'Edit', command: '', kind: 'edit', status: 'completed', locations: [{ path: '/p/src/a.js', line: 4 }], error: '', diff: { added: 2, removed: 1, created: false }, startedAt: null, endedAt: null },
    ]);
    expect(b.chunks(update({ sessionUpdate: 'tool_call' })), 'a call without an id: nothing').to.deep.equal([]);
  });

  it('names a call’s files relative to the session’s folder, inside it', () => {
    // Arrange
    $sessions.set([/** @type {never} */ ({ id: 's-known', folder: '/p/sub' })]);
    try {
      // Act
      const chunk = shape(new MessageBuilder('s-known', 'agent').chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', locations: [{ path: '/p/sub/src/a.js', line: 2 }, { path: '/p/other/b.js' }] }))[0]);
      // Assert
      const [step] = /** @type {{ call: { locations: unknown[] } }[]} */ (chunk.delta?.data?.steps);
      expect(step.call.locations).to.deep.equal([{ path: 'src/a.js', line: 2 }, { path: '/p/other/b.js' }]);
    } finally {
      $sessions.set([]);
    }
  });

  it('folds the narration before each tool call into the reply’s one work part, and leaves the text after the last', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    const say = (/** @type {string} */ text) => b.chunks(textUpdate('agent_message_chunk', text));
    const tool = (/** @type {string} */ id) => b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: id, title: id }));
    // Act
    const chunks = [...say('I will '), ...say('look.'), ...tool('t1'), ...say('Found it.'), ...tool('t2'), ...say('Done.')].map(shape);
    // Assert
    const work = chunks.filter((c) => c.partType === 'work');
    expect(new Set(work.map((c) => c.partId)), 'one work part').to.deep.equal(new Set([`${b.messageId}-work`]));
    const steps = /** @type {{ kind: string, text?: string, call?: { toolCallId: string } }[]} */ (work.at(-1)?.delta?.data?.steps);
    expect(steps.map((s) => s.text ?? s.call?.toolCallId)).to.deep.equal(['I will look.', 't1', 'Found it.', 't2']);
    const texts = chunks.filter((c) => c.partType === 'text');
    const folded = new Set(texts.filter((c) => c.delta?.data?.folded).map((c) => c.partId));
    const parts = [...new Set(texts.map((c) => c.partId))];
    expect(parts.map((id) => folded.has(id ?? ''))).to.deep.equal([true, true, false]);
  });

  it('changes a call’s step in place on its update, folding nothing, timed when live', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent', { live: true });
    b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' }));
    b.chunks(textUpdate('agent_message_chunk', 'Waiting.'));
    // Act
    const chunks = b.chunks(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })).map(shape);
    // Assert
    expect(chunks.map((c) => c.partType)).to.deep.equal(['work']);
    const steps = /** @type {{ call: { status: string, startedAt: unknown, endedAt: unknown } }[]} */ (chunks[0].delta?.data?.steps);
    expect(steps.map((s) => [s.call.status, typeof s.call.startedAt, typeof s.call.endedAt])).to.deep.equal([['completed', 'number', 'number']]);
  });

  it('folds a thought that ends after the work part started, never one before it', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent', { live: true });
    // Act
    const before = shape(b.chunks(textUpdate('agent_thought_chunk', 'plan'))[0]).partId;
    const first = b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1' })).map(shape);
    const after = shape(b.chunks(textUpdate('agent_thought_chunk', 'hmm'))[0]).partId;
    const second = b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't2' })).map(shape);
    // Assert
    expect(first.some((c) => c.partId === before && c.delta?.data?.folded), 'before the work part').to.equal(false);
    const fold = second.findIndex((c) => c.partId === after && c.delta?.data?.folded);
    const end = second.findIndex((c) => c.kind === 'part-end' && c.partId === after);
    expect(fold >= 0 && fold < end, 'folded before its end').to.equal(true);
    const steps = /** @type {{ kind: string, text?: string, startedAt?: number }[]} */ (second.at(-1)?.delta?.data?.steps);
    expect(steps.map((s) => s.kind)).to.deep.equal(['tool', 'thought', 'tool']);
    expect([steps[1].text, typeof steps[1].startedAt]).to.deep.equal(['hmm', 'number']);
  });

  it('keeps narration and thoughts in the order they came, and a thought before the answer only in the row', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    const say = (/** @type {string} */ text) => b.chunks(textUpdate('agent_message_chunk', text));
    const think = (/** @type {string} */ text) => b.chunks(textUpdate('agent_thought_chunk', text));
    const tool = (/** @type {string} */ id) => b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: id }));
    // Act
    const chunks = [...tool('t1'), ...say('Found A.'), ...think('so B'), ...tool('t2'), ...think('last'), ...say('The answer.'), ...b.finish()].map(shape);
    // Assert
    const work = chunks.filter((c) => c.partType === 'work');
    const steps = /** @type {{ kind: string, text?: string }[]} */ (work.at(-1)?.delta?.data?.steps);
    expect(steps.map((s) => s.text ?? s.kind)).to.deep.equal(['tool', 'Found A.', 'so B', 'tool', 'last']);
    const answer = chunks.filter((c) => c.partType === 'text' && c.delta?.text === 'The answer.')[0];
    expect(chunks.some((c) => c.partId === answer.partId && c.delta?.data?.folded), 'the answer stays').to.equal(false);
  });

  it('settles the calls still running when the reply finishes', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'completed' }));
    b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't2', status: 'in_progress' }));
    // Act
    const [done] = b.finish().map(shape);
    // Assert
    const steps = /** @type {{ call: { status: string } }[]} */ (done.delta?.data?.steps);
    expect(steps.map((s) => s.call.status)).to.deep.equal(['completed', 'cancelled']);
  });

  it('keeps subagent cards and the plan as their own parts, never steps', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1' }));
    // Act
    const card = b.subagentCard('c1', { label: 'Explore' }).map(shape);
    const plan = b.chunks(update({ sessionUpdate: 'plan', entries: [{ content: 'a' }] })).map(shape);
    const last = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't2' })).at(-1));
    // Assert
    expect([card.at(-1)?.partType, plan[0].partType]).to.deep.equal(['tool_call', 'plan']);
    const steps = /** @type {{ kind: string }[]} */ (last.delta?.data?.steps);
    expect(steps.map((s) => s.kind)).to.deep.equal(['tool', 'tool']);
  });

  it('runs the work part until the reply finishes, settled by the library when it is stopped; none without a tool call', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    const started = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'completed' }))[0]);
    const stopped = new MessageBuilder('s1', 'agent');
    stopped.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1' }));
    // Act
    const finished = b.finish().map(shape);
    // Assert
    expect(started.delta?.status).to.equal('in_progress');
    expect(finished.map((c) => [c.partType ?? c.kind, c.delta?.status])).to.deep.equal([['work', 'completed'], ['finish', undefined]]);
    const aborted = stopped.finish(true).map(shape);
    expect(aborted.map((c) => [c.partType ?? c.kind, c.delta?.status]), 'aborted: the library settles the part').to.deep.equal([['work', 'in_progress'], ['abort', undefined]]);
    const plain = new MessageBuilder('s1', 'agent');
    plain.chunks(textUpdate('agent_message_chunk', 'Hi'));
    expect(kinds(plain.finish())).to.deep.equal(['finish']);
  });

  it('shows a permission request on its call, making the call when it came first', () => {
    // Arrange
    const b = new MessageBuilder('s1', 'agent');
    b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.txt', status: 'pending' }));
    // Act
    const [chunk] = b.toolCallChunks('t1', 'awaiting-permission');
    // Assert
    expect(/** @type {{ call: { status: string } }[]} */ (shape(chunk).delta?.data?.steps)[0].call.status).to.equal('awaiting-permission');
    const [unseen] = b.toolCallChunks('t0', 'awaiting-permission', 'Run rm');
    const steps = /** @type {{ call: { toolCallId: string, label: string, status: string } }[]} */ (shape(unseen).delta?.data?.steps);
    expect(steps.at(-1)?.call, 'a request before its call makes its step').to.deep.include({ toolCallId: 't0', label: 'Run rm', status: 'awaiting-permission' });
  });

  it('ends a thought when anything else arrives, timing it only when live', () => {
    for (const live of [true, false]) {
      const b = new MessageBuilder('s1', 'agent', { live });
      const thought = shape(b.chunks(textUpdate('agent_thought_chunk', 'hm'))[0]);
      expect(thought.delta?.data !== undefined, `live ${live}: timed`).to.equal(live);
      const out = b.chunks(textUpdate('agent_message_chunk', 'ok'));
      expect(kinds(out), `live ${live}`).to.deep.equal(live ? ['chunk', 'part-end', 'chunk'] : ['part-end', 'chunk']);
      if (live) expect(shape(out[0]).delta?.data?.endedAt).to.be.a('number');
    }
    expect(new MessageBuilder('s1', 'agent').chunks(textUpdate('agent_thought_chunk', '')), 'an empty thought says nothing').to.deep.equal([]);
  });

  it('finishes the message, ending a thought first, or aborts it when the reply was stopped', () => {
    const b = new MessageBuilder('s1', 'agent', { live: true });
    b.chunks(textUpdate('agent_thought_chunk', 'hm'));
    expect(kinds(b.finish())).to.deep.equal(['chunk', 'part-end', 'finish']);
    expect(kinds(new MessageBuilder('s1', 'agent').finish(true))).to.deep.equal(['abort']);
  });
});
