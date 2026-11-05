import { folderOf } from '../../stores/sessions/sessions.js';
import { subagentCardId } from './rules.js';

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {NonNullable<ChxChat['adapter']>} ChxChatAdapter */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['sendMessage']>>[0]} ChxMessage */
/** @typedef {ChxMessage['parts'][number]} ChxMessagePart */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['subscribe']>>[0]} SubscribeHandlers */
/** @typedef {Parameters<SubscribeHandlers['onChunk']>[0]} ChxChunk */
/** @typedef {import('./types.js').AcpSessionUpdate} AcpSessionUpdate */

/**
 * Turns ACP session updates into `<chx-chat>` chunks for one message. Consecutive text (or thought)
 * chunks grow one part; a new tool call or plan in between starts the next text part, so the reply
 * reads in the order the agent worked. Tool calls are keyed by ACP's `toolCallId`; an update of one
 * already shown, which can arrive at any moment, splits nothing.
 *
 * ACP never says a thought is over: any other update but that ends it (`part-end`), and a live one
 * carries when it started and ended in `data` (`startedAt`, `endedAt`).
 */
export class MessageBuilder {
  messageId = crypto.randomUUID();
  /** @type {string | null} */
  #lastKind = null;
  /** Parts started in this message, which numbers the next part's id. */
  #parts = 0;
  /** @type {{ partId: string, startedAt: number | null } | null} The thought being streamed. */
  #thought = null;
  /** @type {Set<string>} Tool calls with a card: a later update changes it in place. */
  #tools = new Set();

  /**
   * @param {string} sessionId
   * @param {string} authorId
   * @param {{ live?: boolean }} [options] `live`: updates arrive as the agent works, so thoughts are timed.
   */
  constructor(sessionId, authorId, { live = false } = {}) {
    this.sessionId = sessionId;
    this.authorId = authorId;
    this.live = live;
  }

  /** @param {string} kind */
  #partId(kind) {
    if (kind !== this.#lastKind) {
      this.#lastKind = kind;
      this.#parts += 1;
    }
    return `${this.messageId}-${kind}${this.#parts}`;
  }

  /**
   * @param {string} partId
   * @param {string} partType
   * @param {Partial<ChxMessagePart>} delta
   * @returns {ChxChunk}
   */
  chunk(partId, partType, delta) {
    const { messageId, sessionId: conversationId, authorId } = this;
    return { messageId, conversationId, authorId, partId, partType, delta };
  }

  /** @param {string} toolCallId */
  toolPartId(toolCallId) {
    return `${this.messageId}-tool-${toolCallId}`;
  }

  /**
   * The card of a subagent the agent handed work to: a tool call part keyed by the subagent, so
   * later fields (its status) update it.
   * @param {string} subagentId
   * @param {Partial<ChxMessagePart>} fields
   * @returns {ChxChunk[]}
   */
  subagentCard(subagentId, fields) {
    this.#lastKind = 'tool';
    return [...this.#endThought(), this.chunk(this.subagentPartId(subagentId), 'tool_call', { ...fields, data: subagentCardData(subagentId) })];
  }

  /** @param {string} subagentId */
  subagentPartId(subagentId) {
    return this.toolPartId(subagentCardId(subagentId));
  }

  /**
   * @param {AcpSessionUpdate} update
   * @returns {ChxChunk[]}
   */
  chunks(update) {
    if (update.sessionUpdate === 'agent_thought_chunk') return this.#thoughtChunks(update);
    const inPlace = this.#tools.has(update.toolCallId ?? '');
    const chunks = this.#chunks(update);
    return chunks.length && !inPlace ? [...this.#endThought(), ...chunks] : chunks;
  }

  /**
   * @param {AcpSessionUpdate} update
   * @returns {ChxChunk[]}
   */
  #thoughtChunks(update) {
    const text = textOf(update);
    if (!text) return [];
    const partId = this.#partId('thought');
    if (this.#thought?.partId === partId) return [this.chunk(partId, 'thought', { text })];
    const startedAt = this.live ? Date.now() : null;
    this.#thought = { partId, startedAt };
    return [this.chunk(partId, 'thought', startedAt === null ? { text } : { text, data: { startedAt } })];
  }

  /** @returns {ChxChunk[]} Ends the thought being streamed, if any. */
  #endThought() {
    const thought = this.#thought;
    if (!thought) return [];
    this.#thought = null;
    const { messageId, sessionId: conversationId } = this;
    /** @type {ChxChunk} */
    const end = { kind: 'part-end', messageId, conversationId, partId: thought.partId };
    if (thought.startedAt === null) return [end];
    return [this.chunk(thought.partId, 'thought', { data: { startedAt: thought.startedAt, endedAt: Date.now() } }), end];
  }

  /**
   * @param {AcpSessionUpdate} update
   * @returns {ChxChunk[]}
   */
  #chunks(update) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk': {
        const text = textOf(update);
        return text ? [this.chunk(this.#partId('text'), 'text', { text })] : [];
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (!update.toolCallId) return [];
        if (!this.#tools.has(update.toolCallId)) {
          this.#tools.add(update.toolCallId);
          this.#lastKind = 'tool';
        }
        return [this.chunk(this.toolPartId(update.toolCallId), 'tool_call', this.#toolDelta(update))];
      }
      case 'plan':
        this.#lastKind = 'plan';
        return [this.chunk(`${this.messageId}-plan`, 'plan', { entries: update.entries ?? [] })];
      default:
        return [];
    }
  }

  /**
   * Only the fields the update carries: every field but `text` replaces the part's.
   * @param {AcpSessionUpdate} update
   * @returns {Partial<ChxMessagePart>}
   */
  #toolDelta(update) {
    /** @type {Partial<ChxMessagePart>} */
    const delta = { data: { toolCallId: update.toolCallId } };
    if (update.title) delta.label = update.title;
    if (update.kind) delta.kind = update.kind;
    if (update.status) delta.status = update.status;
    const reason = update.status === 'failed' ? failureOf(update) : '';
    if (reason) delta.error = reason;
    if (update.locations) {
      delta.locations = update.locations.map(({ path, line }) => ({
        path: relativeTo(folderOf(this.sessionId), path),
        ...(line ? { line } : {}),
      }));
    }
    return delta;
  }

  /**
   * @param {boolean} cancelled The reply was stopped: its last part shows as stopped.
   * @returns {ChxChunk[]} The thought being streamed ends with the message.
   */
  finish(cancelled = false) {
    const { messageId, sessionId: conversationId } = this;
    return [...this.#endThought(), { kind: cancelled ? 'abort' : 'finish', messageId, conversationId }];
  }
}

/**
 * A subagent card's `data`: `subagentId` tells it from a tool call.
 * @param {string} subagentId
 */
export function subagentCardData(subagentId) {
  return { toolCallId: subagentCardId(subagentId), subagentId };
}

/** @param {AcpSessionUpdate} update */
function textOf(update) {
  const content = update.content;
  return !Array.isArray(content) && content?.type === 'text' ? (content.text ?? '') : '';
}

/**
 * Why a tool call failed: the text in its content.
 * @param {AcpSessionUpdate} update
 */
function failureOf(update) {
  const blocks = Array.isArray(update.content) ? update.content : [];
  return blocks.map((block) => ('content' in block && block.content?.type === 'text' ? block.content.text : '')).filter(Boolean).join('\n');
}

/**
 * A path under the project as relative, for display; others as they are.
 * @param {string | null} root
 * @param {string} path
 */
function relativeTo(root, path) {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
