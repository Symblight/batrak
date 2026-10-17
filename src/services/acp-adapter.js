import { splitMessageParts } from '@symblight/chat';
import { sessionCancel, sessionSendPrompt, sessionSetConfigOption } from './ipc.js';
import { log } from './logger.js';
import { MESSAGE_PART_RULES } from '../models/chat-parts.js';
import { applyAgentOptions, setUsage } from '../stores/composer.js';
import { projectOf, setSessionStatus } from '../stores/sessions.js';
import {
  $sessionNotices,
  addPermissionRequest,
  clearPermissionRequests,
  setSessionNotice,
} from '../stores/session-runtime.js';

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {NonNullable<ChxChat['adapter']>} ChxChatAdapter */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['sendMessage']>>[0]} ChxMessage */
/** @typedef {ChxMessage['parts'][number]} ChxMessagePart */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['subscribe']>>[0]} SubscribeHandlers */
/** @typedef {Parameters<SubscribeHandlers['onChunk']>[0]} ChxChunk */
/** @typedef {Exclude<Awaited<ReturnType<NonNullable<ChxChatAdapter['sendMessage']>>>, void>} ReplyStream */
/** @typedef {import('../models/types.js').SessionEnvelope} SessionEnvelope */
/** @typedef {import('../models/types.js').AcpSessionUpdate} AcpSessionUpdate */
/** @typedef {import('../models/types.js').PromptInput} PromptInput */
/** @typedef {import('../models/types.js').TranscriptEntry} TranscriptEntry */

/** The chat's author ids: the user (`<chx-chat>`'s `userId`) and every agent. */
export const USER_ID = 'me';
const AGENT_ID = 'agent';

/**
 * Turns ACP session updates into `<chx-chat>` chunks for one message. Consecutive text (or thought)
 * chunks grow one part; a tool call or plan in between starts the next text part, so the reply
 * reads in the order the agent worked. Tool calls are keyed by ACP's `toolCallId`.
 */
class MessageBuilder {
  messageId = crypto.randomUUID();
  /** @type {string | null} */
  #lastKind = null;
  #parts = 0;

  /**
   * @param {string} sessionId
   * @param {string} authorId
   */
  constructor(sessionId, authorId) {
    this.sessionId = sessionId;
    this.authorId = authorId;
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
   * @param {AcpSessionUpdate} update
   * @returns {ChxChunk[]}
   */
  chunks(update) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk': {
        const text = textOf(update);
        return text ? [this.chunk(this.#partId('text'), 'text', { text })] : [];
      }
      case 'agent_thought_chunk': {
        const text = textOf(update);
        return text ? [this.chunk(this.#partId('thought'), 'thought', { text })] : [];
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (!update.toolCallId) return [];
        this.#lastKind = 'tool';
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
    if (update.locations) {
      delta.locations = update.locations.map(({ path, line }) => ({
        path: relativeTo(projectOf(this.sessionId), path),
        ...(line ? { line } : {}),
      }));
    }
    return delta;
  }

  /** @returns {ChxChunk} */
  finish(cancelled = false) {
    const { messageId, sessionId: conversationId } = this;
    return { kind: cancelled ? 'abort' : 'finish', messageId, conversationId };
  }
}

/** @param {AcpSessionUpdate} update */
function textOf(update) {
  const content = update.content;
  return content?.type === 'text' ? (content.text ?? '') : '';
}

/**
 * A path under the project as relative, for display; others as they are.
 * @param {string | null} root
 * @param {string} path
 */
function relativeTo(root, path) {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/**
 * The open turn of a session: the reply stream `sendMessage` returned.
 * @typedef {Object} Turn
 * @property {MessageBuilder} builder
 * @property {ReadableStreamDefaultController<ChxChunk>} controller
 * @property {boolean} started After `turn-start`: updates before it are history a starting agent replays.
 */

/** @type {Map<string, Turn>} By session id. */
const turns = new Map();
/** @type {Map<string, MessageBuilder>} Messages arriving outside a turn (`session/load` replaying history). */
const replays = new Map();
/** Sessions whose turn the user stopped; its late updates are dropped until its `turn-end`. */
const stopped = new Set();
/** @type {Map<string, Promise<unknown>>} Sessions being created, by id; a send waits for it. */
const creating = new Map();
/** @type {SubscribeHandlers | null} */
let handlers = null;
/** @type {ChxChunk[]} Chunks to deliver once the chat subscribes (history restored before it's up). */
const undelivered = [];
/** Sessions whose history was restored from the transcript: an agent's own replay would repeat it. */
const restored = new Set();

/** @param {ChxChunk} chunk */
function deliver(chunk) {
  if (handlers) handlers.onChunk(chunk);
  else undelivered.push(chunk);
}

/**
 * A send for this session waits until the backend created it; one whose creation failed fails.
 * @param {string} sessionId
 * @param {Promise<unknown>} created
 */
export function trackCreate(sessionId, created) {
  creating.set(sessionId, created);
  created.finally(() => creating.get(sessionId) === created && creating.delete(sessionId)).catch(() => {});
}

/**
 * @param {string} sessionId
 * @param {ChxChunk} chunk
 */
function enqueue(sessionId, chunk) {
  try {
    turns.get(sessionId)?.controller.enqueue(chunk);
  } catch {
    // The chat stopped reading (aborted): nothing to deliver to.
  }
}

/**
 * Ends the session's turn stream.
 * @param {string} sessionId
 * @param {{ cancelled?: boolean, error?: string }} how
 */
function endTurn(sessionId, { cancelled = false, error }) {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turns.delete(sessionId);
  try {
    if (error !== undefined) {
      turn.controller.error(new Error(error));
    } else {
      turn.controller.enqueue(turn.builder.finish(cancelled));
      turn.controller.close();
    }
  } catch {
    // Already closed by an abort.
  }
}

/**
 * An update outside a turn: history replayed by `session/load`. Each change of author ends the
 * message being built.
 * @param {string} sessionId
 * @param {AcpSessionUpdate} update
 */
function replay(sessionId, update) {
  if (restored.has(sessionId)) return;
  const authorId = update.sessionUpdate === 'user_message_chunk' ? USER_ID : AGENT_ID;
  let builder = replays.get(sessionId);
  if (builder && builder.authorId !== authorId) builder = undefined;
  const next = builder ?? new MessageBuilder(sessionId, authorId);
  const chunks = next.chunks(update);
  // Updates with nothing to show (usage, available commands) open no message: finishing one with
  // no parts would leave an empty bubble.
  if (!chunks.length) return;
  if (next !== builder) {
    endReplay(sessionId);
    replays.set(sessionId, next);
  }
  for (const chunk of chunks) deliver(chunk);
}

/** @param {string} sessionId */
function endReplay(sessionId) {
  const builder = replays.get(sessionId);
  replays.delete(sessionId);
  if (builder) deliver(builder.finish());
}

/**
 * The text a recorded prompt showed: its text block (file chips are written into it inline).
 * @param {PromptInput[]} prompt
 */
function promptText(prompt) {
  return prompt
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Shows a session's recorded conversation (`session_history`) again: each prompt as your message,
 * each turn's updates as the agent's reply.
 * @param {string} sessionId
 * @param {TranscriptEntry[]} entries Oldest first.
 */
export function restoreHistory(sessionId, entries) {
  if (!entries.length) return;
  restored.add(sessionId);
  /** @type {MessageBuilder | null} */
  let reply = null;
  const endReply = (cancelled = false) => {
    if (reply) deliver(reply.finish(cancelled));
    reply = null;
  };
  for (const entry of entries) {
    if (entry.kind === 'prompt') {
      endReply();
      const message = new MessageBuilder(sessionId, USER_ID);
      deliver(message.chunk(`${message.messageId}-t1`, 'text', { text: promptText(entry.prompt) }));
      deliver(message.finish());
    } else if (entry.kind === 'update') {
      reply ??= new MessageBuilder(sessionId, AGENT_ID);
      for (const chunk of reply.chunks(entry.update)) deliver(chunk);
    } else {
      if (entry.stopReason === 'error' && entry.message) {
        reply ??= new MessageBuilder(sessionId, AGENT_ID);
        deliver(reply.chunk(`${reply.messageId}-error`, 'text', { text: `\n\n_${entry.message}_` }));
      }
      endReply(entry.stopReason === 'cancelled');
    }
  }
  endReply(); // a turn the app quit in the middle of
}

/**
 * Takes one event from a session's channel: updates into the turn's stream (or the replay),
 * status and notices into the stores, permission requests for the banner.
 * @param {SessionEnvelope} event
 */
export function handleSessionEvent(event) {
  const { sessionId } = event;
  switch (event.kind) {
    case 'update': {
      const update = event.payload;
      if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number' && typeof update.size === 'number') {
        setUsage(sessionId, { used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) });
        return;
      }
      if (stopped.has(sessionId)) return;
      const turn = turns.get(sessionId);
      if (turn?.started) {
        for (const chunk of turn.builder.chunks(event.payload)) enqueue(sessionId, chunk);
      } else {
        replay(sessionId, event.payload);
      }
      return;
    }
    case 'status': {
      const { status, message } = event.payload;
      setSessionStatus(sessionId, status);
      setSessionNotice(sessionId, noticeOf(sessionId, status, message ?? null));
      if (status !== 'preparing' && status !== 'starting') endReplay(sessionId);
      return;
    }
    case 'permission-request': {
      const { requestId, toolCall, options } = event.payload;
      const toolCallId = toolCall.toolCallId ?? null;
      addPermissionRequest(sessionId, { requestId, toolCallId, title: toolCall.title ?? 'The agent asks for permission', options });
      const turn = turns.get(sessionId);
      if (turn && toolCallId) {
        enqueue(sessionId, turn.builder.chunk(turn.builder.toolPartId(toolCallId), 'tool_call', { status: 'awaiting-permission' }));
      }
      return;
    }
    case 'config-options':
      // Picks made before the agent ran (or while it started) go to it now.
      for (const { configId, value } of applyAgentOptions(sessionId, event.payload.configOptions)) {
        sessionSetConfigOption(sessionId, configId, value).catch((err) =>
          log('warn', `the agent refused ${configId}=${value}: ${err}`),
        );
      }
      return;
    case 'turn-start': {
      endReplay(sessionId);
      const turn = turns.get(sessionId);
      if (turn) turn.started = true;
      return;
    }
    case 'turn-end':
      stopped.delete(sessionId);
      clearPermissionRequests(sessionId);
      endTurn(sessionId, { cancelled: event.payload.stopReason === 'cancelled' });
      return;
    case 'untrusted':
      // After the `error` status, whose notice it replaces.
      setSessionNotice(sessionId, { kind: 'untrusted', message: event.payload.message, launch: event.payload.launch });
      return;
    case 'error':
      if (event.payload.turn) {
        // A turn the user stopped can fail rather than end `cancelled`: its late updates are over too.
        stopped.delete(sessionId);
        clearPermissionRequests(sessionId);
        endTurn(sessionId, { error: event.payload.message });
      } else {
        setSessionNotice(sessionId, { kind: 'error', message: event.payload.message });
      }
      return;
  }
}

/**
 * The notice a status brings: progress while starting, the error, the agent stopped, or the
 * backend's message (e.g. "Agent history not restored"). An info notice outlives later statuses
 * until it's dismissed.
 * @param {string} sessionId
 * @param {import('../models/types.js').SessionStatus} status
 * @param {string | null} message
 * @returns {import('../models/types.js').SessionNotice | null}
 */
function noticeOf(sessionId, status, message) {
  if (status === 'preparing' || status === 'starting') return { kind: 'progress', message: message ?? 'Starting agent…' };
  if (status === 'error') return { kind: 'error', message: message ?? 'The agent failed' };
  if (status === 'stopped') return { kind: 'stopped', message: 'The agent is not running; your next message starts it.' };
  if (message) return { kind: 'info', message };
  const current = $sessionNotices.get()[sessionId] ?? null;
  return current?.kind === 'info' ? current : null;
}

/**
 * Forgets everything kept for a removed session; its open turn, if any, ends cancelled.
 * @param {string} sessionId
 */
export function forgetSession(sessionId) {
  endTurn(sessionId, { cancelled: true });
  replays.delete(sessionId);
  restored.delete(sessionId);
  stopped.delete(sessionId);
  creating.delete(sessionId);
  clearPermissionRequests(sessionId);
  setSessionNotice(sessionId, null);
}

/**
 * A chip's lines: `12` or `12-23`.
 * @param {unknown} lines
 * @returns {[number, number] | null}
 */
function lineRange(lines) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(lines ?? ''));
  if (!match) return null;
  const from = Number(match[1]);
  return [from, Number(match[2] ?? from)];
}

/**
 * The prompt of a sent message: its text with chips written inline (`@path`, `@folder/`, `path:12-23`), then a
 * resource for each file chip (a mention, or the lines it names).
 * @param {ChxMessage} message
 * @returns {PromptInput[]}
 */
export function promptOf(message) {
  const flat = message.parts.length === 1 && typeof message.parts[0].html === 'string' ? message.parts[0] : null;
  const parts = (flat && splitMessageParts(message.id, flat.html ?? '', MESSAGE_PART_RULES)) ?? message.parts;
  let text = '';
  /** @type {PromptInput[]} */
  const resources = [];
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'longText') {
      text += part.text ?? '';
    } else if (part.type === 'code') {
      text += `\n\`\`\`${part.lang ?? ''}\n${part.text ?? ''}\n\`\`\`\n`;
    } else if (part.type === 'chip') {
      const path = typeof part.data?.path === 'string' ? part.data.path : null;
      const range = lineRange(part.data?.lines);
      if (path && range) {
        text += `${path}:${part.data?.lines}`;
        resources.push({ type: 'selection', path, fromLine: range[0], toLine: range[1] });
      } else if (path) {
        // A folder ends in a slash, so the agent (and a restored message) can tell it from a file.
        text += part.data?.kind === 'folder' ? `@${path}/` : `@${path}`;
        resources.push({ type: 'mention', path });
      } else {
        text += part.label ?? '';
      }
    }
    // TODO: attachments (images) as ACP image blocks, once the agent's promptCapabilities are known.
  }
  return [...(text.trim() ? [{ type: /** @type {const} */ ('text'), text: text.trim() }] : []), ...resources];
}

/**
 * The chat's adapter for ACP sessions: a send starts a turn and returns its reply stream, fed by
 * the session's events; abort cancels the turn. History replayed by `session/load` arrives through
 * `subscribe`.
 * @type {ChxChatAdapter}
 */
export const acpAdapter = {
  subscribe(subscribed) {
    handlers = subscribed;
    subscribed.onConnectionChange('connected');
    for (const chunk of undelivered.splice(0)) subscribed.onChunk(chunk);
    return () => {
      if (handlers === subscribed) handlers = null;
    };
  },

  async sendMessage(message, { signal }) {
    const sessionId = message.conversationId;
    if (!sessionId) throw new Error('No session');
    await creating.get(sessionId);
    const prompt = promptOf(message);
    if (!prompt.length) throw new Error('Nothing to send');
    endReplay(sessionId);
    /** @type {ReadableStreamDefaultController<ChxChunk> | undefined} */
    let controller;
    /** @type {ReplyStream} */
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    /** @type {Turn} */
    const turn = {
      builder: new MessageBuilder(sessionId, AGENT_ID),
      controller: /** @type {ReadableStreamDefaultController<ChxChunk>} */ (controller),
      started: false,
    };
    turns.set(sessionId, turn);
    signal.addEventListener(
      'abort',
      () => {
        if (turns.get(sessionId) !== turn) return;
        stopped.add(sessionId);
        sessionCancel(sessionId).catch((err) => log('warn', `cancel failed: ${err}`));
        endTurn(sessionId, { cancelled: true });
      },
      { once: true },
    );
    try {
      await sessionSendPrompt(sessionId, prompt);
    } catch (err) {
      if (turns.get(sessionId) === turn) turns.delete(sessionId);
      throw err;
    }
    return stream;
  },
};
