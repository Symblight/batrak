import { expect } from '@esm-bundle/chai';
import { MessageBuilder } from '../message-builder.js';
import { $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../../../models/types/types.js').AcpSessionUpdate} AcpSessionUpdate */
/**
 * A chunk as the tests read it.
 * @typedef {Object} Shape
 * @property {string} [kind]
 * @property {string} [partId]
 * @property {string} [messageId]
 * @property {string} [conversationId]
 * @property {string} [authorId]
 * @property {Record<string, unknown> & { text?: string, data?: { startedAt?: number, endedAt?: number }, locations?: unknown[] }} [delta]
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
  it('grows one part from consecutive text chunks, and starts the next after a tool call or plan', () => {
    const b = new MessageBuilder('s1', 'agent');
    const a1 = shape(b.chunks(textUpdate('agent_message_chunk', 'Hel'))[0]);
    const a2 = shape(b.chunks(textUpdate('agent_message_chunk', 'lo'))[0]);
    expect(a2.partId, 'the same part').to.equal(a1.partId);
    expect(a2.delta?.text).to.equal('lo');
    const tool = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }))[0]);
    const after = shape(b.chunks(textUpdate('agent_message_chunk', 'Done'))[0]);
    expect(after.partId, 'a new part after the tool call').to.not.equal(a1.partId);
    expect(tool.partId, 'tool calls are keyed by their id').to.equal(b.toolPartId('t1'));
    expect([a1.messageId, a1.conversationId, a1.authorId]).to.deep.equal([b.messageId, 's1', 'agent']);
  });

  it('sends only the fields a tool update carries, and says nothing for a call without an id', () => {
    const b = new MessageBuilder('unknown-session', 'agent');
    const first = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', locations: [{ path: '/p/src/a.js', line: 4 }, { path: '/p/b.js' }] }))[0]);
    expect(Object.keys(first.delta ?? {}).sort(), 'no status or kind: not carried').to.deep.equal(['data', 'label', 'locations']);
    expect(first.delta?.locations, 'no folder known: paths as they are').to.deep.equal([{ path: '/p/src/a.js', line: 4 }, { path: '/p/b.js' }]);
    const next = shape(b.chunks(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }))[0]);
    expect(Object.keys(next.delta ?? {}).sort()).to.deep.equal(['data', 'status']);
    expect(b.chunks(update({ sessionUpdate: 'tool_call' }))).to.deep.equal([]);
  });

  it('shows a tool call’s locations relative to the session’s folder when it is known', () => {
    $sessions.set([/** @type {never} */ ({ id: 's-known', folder: '/p/sub' })]);
    try {
      const b = new MessageBuilder('s-known', 'agent');
      const call = shape(b.chunks(update({ sessionUpdate: 'tool_call', toolCallId: 't1', locations: [{ path: '/p/sub/src/a.js', line: 2 }, { path: '/p/other/b.js' }] }))[0]);
      expect(call.delta?.locations, 'inside the folder: relative; outside: as it is').to.deep.equal([{ path: 'src/a.js', line: 2 }, { path: '/p/other/b.js' }]);
    } finally {
      $sessions.set([]);
    }
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

  it('puts the plan in one part and ignores updates it does not show', () => {
    const b = new MessageBuilder('s1', 'agent');
    const plan = shape(b.chunks(update({ sessionUpdate: 'plan', entries: [{ content: 'a' }] }))[0]);
    expect(plan.partId).to.equal(`${b.messageId}-plan`);
    expect(b.chunks(textUpdate('available_commands_update')), 'not shown').to.deep.equal([]);
  });

  it('finishes the message, ending a thought first, or aborts it when the reply was stopped', () => {
    const b = new MessageBuilder('s1', 'agent', { live: true });
    b.chunks(textUpdate('agent_thought_chunk', 'hm'));
    expect(kinds(b.finish())).to.deep.equal(['chunk', 'part-end', 'finish']);
    expect(kinds(new MessageBuilder('s1', 'agent').finish(true))).to.deep.equal(['abort']);
  });
});
