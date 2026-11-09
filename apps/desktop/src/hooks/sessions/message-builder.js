import { folderOf } from '../../stores/sessions/sessions.js';
import { subagentCardId } from './rules.js';

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {NonNullable<ChxChat['adapter']>} ChxChatAdapter */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['sendMessage']>>[0]} ChxMessage */
/** @typedef {ChxMessage['parts'][number]} ChxMessagePart */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['subscribe']>>[0]} SubscribeHandlers */
/** @typedef {Parameters<SubscribeHandlers['onChunk']>[0]} ChxChunk */
/** @typedef {import('./types.js').AcpSessionUpdate} AcpSessionUpdate */
/** @typedef {import('./types.js').ToolCallView} ToolCallView */
/** @typedef {import('./types.js').ToolCallStatus} ToolCallStatus */
/** @typedef {import('./types.js').WorkStep} WorkStep */

/** Statuses of a call that still runs. */
const RUNNING = new Set(['pending', 'in_progress', 'awaiting-permission']);

/**
 * Turns ACP session updates into `<chx-chat>` chunks for one message. Consecutive text (or thought)
 * chunks grow one part; a new tool call or plan in between starts the next text part, so the reply
 * reads in the order the agent worked.
 *
 * A reply that calls a tool has one `work` part (spec: `docs/specs/reply-work-row.md`), created by
 * its first tool call: its steps (`data.steps`, `WorkStep[]`) are the tool calls (`ToolCallView`,
 * keyed by ACP's `toolCallId`). The text a tool call followed (narration) and the thoughts that
 * ended after it started stay parts, as they streamed, marked `data.folded` so they're drawn as
 * nothing; the text after the last tool call is the answer. Its
 * `status` runs until `finish()`, so a reply that is stopped settles it.
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
  /** @type {WorkStep[] | null} The work part's steps; `null` until the first tool call. */
  #steps = null;
  /** @type {Set<string>} Tool calls among the steps: a later update changes its step in place. */
  #tools = new Set();
  /** @type {Set<string>} Text parts since the last tool call: narration once a call follows, else the answer. */
  #since = new Set();

  /**
   * @param {string} sessionId
   * @param {string} authorId
   * @param {{ live?: boolean }} [options] `live`: updates arrive as the agent works, so thoughts and tool calls are timed.
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

  get #workPartId() {
    return `${this.messageId}-work`;
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
   * later fields (its status) update it. Never a step of the work part.
   * @param {string} subagentId
   * @param {Partial<ChxMessagePart>} fields
   * @returns {ChxChunk[]}
   */
  subagentCard(subagentId, fields) {
    const end = this.#endThought();
    this.#lastKind = 'subagent';
    return [...end, this.chunk(this.subagentPartId(subagentId), 'tool_call', { ...fields, data: subagentCardData(subagentId) })];
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
    // A thought ends before what follows it is shown, so it's folded (or not) as what came first.
    const end = this.#shows(update) && !this.#tools.has(update.toolCallId ?? '') ? this.#endThought() : [];
    return [...end, ...this.#chunks(update)];
  }

  /**
   * Whether the update shows something: what ends a thought.
   * @param {AcpSessionUpdate} update
   */
  #shows(update) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        return textOf(update) !== '';
      case 'tool_call':
      case 'tool_call_update':
        return Boolean(update.toolCallId);
      case 'plan':
        return true;
      default:
        return false;
    }
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

  /**
   * Ends the thought being streamed, if any; one that ends while the work part exists is folded.
   * @returns {ChxChunk[]}
   */
  #endThought() {
    const thought = this.#thought;
    if (!thought) return [];
    this.#thought = null;
    const { messageId, sessionId: conversationId } = this;
    /** @type {ChxChunk} */
    const end = { kind: 'part-end', messageId, conversationId, partId: thought.partId };
    const { startedAt } = thought;
    const times = startedAt === null ? {} : { startedAt, endedAt: Date.now() };
    if (!this.#steps) return startedAt === null ? [end] : [this.chunk(thought.partId, 'thought', { data: times }), end];
    return [this.chunk(thought.partId, 'thought', { data: { ...times, folded: true } }), end];
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
        if (!text) return [];
        const partId = this.#partId('text');
        this.#since.add(partId);
        return [this.chunk(partId, 'text', { text })];
      }
      case 'tool_call':
      case 'tool_call_update':
        return update.toolCallId ? this.#toolChunks(update.toolCallId, update) : [];
      case 'plan':
        this.#lastKind = 'plan';
        return [this.chunk(`${this.messageId}-plan`, 'plan', { entries: update.entries ?? [] })];
      default:
        return [];
    }
  }

  /**
   * The chunks after `update` of `toolCallId`: a call not seen yet folds what was said since the
   * last one (narration) and becomes a step of the work part, which the first call creates.
   * @param {string} toolCallId
   * @param {AcpSessionUpdate} update
   * @returns {ChxChunk[]}
   */
  #toolChunks(toolCallId, update) {
    /** @type {ChxChunk[]} */
    let folds = [];
    if (!this.#tools.has(toolCallId)) {
      this.#tools.add(toolCallId);
      this.#lastKind = 'tool';
      folds = [...this.#since].map((partId) => this.chunk(partId, 'text', { data: { folded: true } }));
      this.#since.clear();
      const call = newCall(toolCallId, this.live ? Date.now() : null);
      this.#steps = [...(this.#steps ?? []), { kind: 'tool', call }];
    }
    this.#updateCall(toolCallId, (call) => this.#updated(call, update));
    return [...folds, this.#workChunk()];
  }

  /**
   * The chunks that show `status` on a call (a permission request), making the call under `title`
   * when it isn't shown yet.
   * @param {string} toolCallId
   * @param {ToolCallStatus} status
   * @param {string} [title]
   * @returns {ChxChunk[]}
   */
  toolCallChunks(toolCallId, status, title = '') {
    // A request can come before its call: it makes the call (its folds; the work chunk follows).
    const made = this.#tools.has(toolCallId) ? [] : this.#toolChunks(toolCallId, { sessionUpdate: 'tool_call', toolCallId, title }).slice(0, -1);
    this.#updateCall(toolCallId, (call) => ({ ...call, status }));
    return [...made, this.#workChunk()];
  }

  /**
   * @param {string} toolCallId
   * @param {(call: ToolCallView) => ToolCallView} change
   */
  #updateCall(toolCallId, change) {
    this.#steps = (this.#steps ?? []).map((step) =>
      step.call.toolCallId === toolCallId ? { kind: 'tool', call: change(step.call) } : step,
    );
  }

  /** @param {'in_progress' | 'completed'} [status] */
  #workChunk(status = 'in_progress') {
    return this.chunk(this.#workPartId, 'work', { status, data: { steps: this.#steps ?? [] } });
  }

  /**
   * `call` with the fields `update` carries. Once the backend worded its label (`shownLabel`), a
   * title never replaces it; the command comes only from the backend (`shownCommand`).
   * @param {ToolCallView} call
   * @param {AcpSessionUpdate} update
   * @returns {ToolCallView}
   */
  #updated(call, update) {
    const next = { ...call };
    if (update.shownLabel) {
      next.label = update.shownLabel;
      next.worded = true;
    } else if (update.title && !call.worded) {
      next.label = update.title;
    }
    if (update.shownCommand) next.command = update.shownCommand;
    if (update.kind) next.kind = update.kind;
    if (update.status) next.status = update.status;
    if (update.status && !RUNNING.has(update.status) && call.startedAt !== null && call.endedAt === null) next.endedAt = Date.now();
    if (update.status === 'failed') next.error = failureOf(update);
    if (update.shownDiff) next.diff = update.shownDiff;
    if (update.locations) {
      next.locations = update.locations.map(({ path, line }) => ({
        path: relativeTo(folderOf(this.sessionId), path),
        ...(line ? { line } : {}),
      }));
    }
    return next;
  }

  /**
   * @param {boolean} cancelled The reply was stopped: its last part shows as stopped.
   * @returns {ChxChunk[]} The thought being streamed ends with the message.
   */
  finish(cancelled = false) {
    const { messageId, sessionId: conversationId } = this;
    const end = this.#endThought();
    if (!this.#steps) return [...end, { kind: cancelled ? 'abort' : 'finish', messageId, conversationId }];
    // The text after the last call is the answer. A call the agent never ended is settled here:
    // the library settles the part, not its calls.
    this.#steps = this.#steps.map((step) =>
      RUNNING.has(step.call.status) ? { kind: 'tool', call: { ...step.call, status: 'cancelled' } } : step,
    );
    // An abort settles the part (`cancelled`) itself; a finish would too, unless it's `completed`.
    const work = this.#workChunk(cancelled ? 'in_progress' : 'completed');
    return [...end, work, { kind: cancelled ? 'abort' : 'finish', messageId, conversationId }];
  }
}

/**
 * A subagent card's `data`: `subagentId` tells it from a tool call.
 * @param {string} subagentId
 */
export function subagentCardData(subagentId) {
  return { toolCallId: subagentCardId(subagentId), subagentId };
}

/**
 * A call before its first update is applied.
 * @param {string} toolCallId
 * @param {number | null} startedAt
 * @returns {ToolCallView}
 */
function newCall(toolCallId, startedAt) {
  return { toolCallId, label: '', worded: false, command: '', kind: 'other', status: 'pending', locations: [], error: '', diff: null, startedAt, endedAt: null };
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
