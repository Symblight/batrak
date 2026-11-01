import { app } from '../app/app.js';
import { sessionCancel, sessionSendPrompt, sessionSetConfigOption } from './commands.js';
import { MessageBuilder } from './message-builder.js';
import { promptOf } from './prompt.js';
import { returnPrompt } from '../../stores/chat/chat.js';
import { applyAgentOptions } from '../../stores/composer/composer.js';
import { setContextUsage } from '../../stores/context-usage/context-usage.js';
import { $terminals, sessionTerminalOf, terminalExited } from '../../stores/terminals/terminals.js';
import { setSessionStatus, touchSession, upsertSession } from '../../stores/sessions/sessions.js';
import {
  $sessionNotices,
  addPermissionRequest,
  clearPermissionRequests,
  dismissSessionNotice,
  setSessionNotice,
} from '../../stores/session-runtime/session-runtime.js';
import { awaitTrust } from '../../stores/trust/trust.js';

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {NonNullable<ChxChat['adapter']>} ChxChatAdapter */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['sendMessage']>>[0]} ChxMessage */
/** @typedef {Parameters<NonNullable<ChxChatAdapter['subscribe']>>[0]} SubscribeHandlers */
/** @typedef {Parameters<SubscribeHandlers['onChunk']>[0]} ChxChunk */
/** @typedef {Exclude<Awaited<ReturnType<NonNullable<ChxChatAdapter['sendMessage']>>>, void>} ReplyStream */
/** @typedef {import('./types.js').SessionEnvelope} SessionEnvelope */
/** @typedef {import('./types.js').AcpSessionUpdate} AcpSessionUpdate */
/** @typedef {import('./types.js').PromptInput} PromptInput */

/** The chat's author ids: the user (`<chx-chat>`'s `userId`) and every agent. */
export const USER_ID = 'me';
const AGENT_ID = 'agent';

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
/**
 * Sessions whose chat has their history this launch (an agent's replay, or a turn of its own): a
 * later load (after an idle stop) replays it again, which would repeat it.
 */
const loaded = new Set();
/** Sessions whose agent is replaying their history now (`session/load`). */
const replaying = new Set();

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
      for (const chunk of turn.builder.finish(cancelled)) turn.controller.enqueue(chunk);
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
  if (loaded.has(sessionId)) return;
  replaying.add(sessionId);
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
  if (builder) builder.finish().forEach(deliver);
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
        setContextUsage(sessionId, { used: update.used, size: update.size });
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
      if (status !== 'preparing' && status !== 'starting') {
        endReplay(sessionId);
        if (replaying.delete(sessionId)) loaded.add(sessionId);
      }
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
          app.log('warn', `the agent refused ${configId}=${value}: ${err}`),
        );
      }
      return;
    case 'queued': {
      const { holder } = event.payload;
      const message = holder.title === null ? 'Waiting for another session to finish' : `Waiting for "${holder.title}" to finish`;
      setSessionNotice(sessionId, { kind: 'queued', message, holder });
      return;
    }
    case 'overlap': {
      const { path, other } = event.payload;
      const current = $sessionNotices.get()[sessionId];
      const under = current?.kind === 'overlap' ? current.under : current?.kind === 'info' || current?.kind === 'outdated' ? current : undefined;
      const message = `${path} was also changed by "${other.title}"`;
      setSessionNotice(sessionId, under ? { kind: 'overlap', message, under } : { kind: 'overlap', message });
      return;
    }
    case 'turn-start': {
      endReplay(sessionId);
      const turn = turns.get(sessionId);
      if (turn) turn.started = true;
      return;
    }
    case 'activity':
      touchSession(sessionId, event.payload.at);
      return;
    case 'turn-end':
      loaded.add(sessionId);
      touchSession(sessionId, event.payload.at);
      stopped.delete(sessionId);
      clearPermissionRequests(sessionId);
      if ($sessionNotices.get()[sessionId]?.kind === 'overlap') dismissSessionNotice(sessionId);
      endTurn(sessionId, { cancelled: event.payload.stopReason === 'cancelled' });
      return;
    case 'session':
      // The agent named it (`session_info_update`).
      upsertSession(event.payload);
      return;
    case 'untrusted':
      // After the `error` status, whose notice stays: the trust dialog asks, and starts it once trusted.
      awaitTrust(sessionId);
      return;
    case 'agent-outdated': {
      const { message } = event.payload;
      const current = $sessionNotices.get()[sessionId];
      if (current?.kind === 'overlap') {
        // Under the overlap until the turn ends.
        const { under, ...overlap } = current;
        if (message !== null) setSessionNotice(sessionId, { ...overlap, under: { kind: 'outdated', message } });
        else if (under?.kind === 'outdated') setSessionNotice(sessionId, overlap);
      } else if (message !== null) setSessionNotice(sessionId, { kind: 'outdated', message });
      else if (current?.kind === 'outdated') setSessionNotice(sessionId, null);
      return;
    }
    case 'unconfigured': {
      // After the `error` status, whose notice says so: the backend starts it again once agents.json has the agent
      // (or it's turned on again, which the notice offers).
      const { agentId, reason } = event.payload;
      const current = $sessionNotices.get()[sessionId];
      if (reason === 'off' && current?.kind === 'error') setSessionNotice(sessionId, { ...current, offAgent: agentId });
      return;
    }
    case 'sign-in': {
      // After the `error` status: the agent asks for a sign-in (`null`: a start worked, or Stop).
      const signIn = event.payload;
      if (signIn) {
        setSessionNotice(sessionId, { kind: 'sign-in', message: `Sign in to ${signIn.agentName} to continue.`, signIn });
      } else if ($sessionNotices.get()[sessionId]?.kind === 'sign-in') {
        setSessionNotice(sessionId, null);
      }
      return;
    }
    case 'held': {
      // The turn waits for the sign-in; the agent that starts after it may replay its history first,
      // which isn't this reply. The next `turn-start` opens it again.
      const turn = turns.get(sessionId);
      if (turn) turn.started = false;
      return;
    }
    case 'prompt-returned':
      returnPrompt(sessionId, promptText(event.payload.prompt));
      return;
    case 'cli-exited': {
      const terminalId = sessionTerminalOf(sessionId);
      if (terminalId !== null && $terminals.get()[terminalId]?.status !== 'exited') terminalExited(terminalId, event.payload);
      return;
    }
    case 'error':
      if (event.payload.turn) {
        touchSession(sessionId, event.payload.at);
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
 * @param {import('./types.js').SessionStatus} status
 * @param {string | null} message
 * @returns {import('./types.js').SessionNotice | null}
 */
function noticeOf(sessionId, status, message) {
  if (status === 'preparing' || status === 'starting') return { kind: 'progress', message: message ?? 'Starting agent…' };
  if (status === 'error') return { kind: 'error', message: message ?? 'The agent failed' };
  if (status === 'stopped') return { kind: 'stopped', message: 'The agent is not running; your next message starts it.' };
  if (message) return { kind: 'info', message };
  const current = $sessionNotices.get()[sessionId] ?? null;
  // The `queued` event says what it waits for.
  if (status === 'queued' && current?.kind === 'queued') return current;
  // Information and a changed launch stay through the session's turns, an overlap through its turn.
  return current?.kind === 'info' || current?.kind === 'outdated' || current?.kind === 'overlap' ? current : null;
}

/**
 * Lets the session's next `session/load` replay its history again (the chat's copy of it was
 * dropped): turns its CLI ran since aren't in that copy.
 * @param {string} sessionId
 */
export function forgetHistory(sessionId) {
  replays.delete(sessionId);
  loaded.delete(sessionId);
  replaying.delete(sessionId);
}

/**
 * Forgets everything kept for a removed session; its open turn, if any, ends cancelled.
 * @param {string} sessionId
 */
export function forgetSession(sessionId) {
  endTurn(sessionId, { cancelled: true });
  replays.delete(sessionId);
  loaded.delete(sessionId);
  replaying.delete(sessionId);
  stopped.delete(sessionId);
  creating.delete(sessionId);
  clearPermissionRequests(sessionId);
  setSessionNotice(sessionId, null);
}

/**
 * The chat's adapter for ACP sessions: a send starts a turn and returns its reply stream, fed by
 * the session's events; abort cancels the turn. History replayed by `session/load` arrives through
 * `subscribe`.
 * @type {ChxChatAdapter}
 */
export const acpAdapter = {
  /** @param {SubscribeHandlers} subscribed The chat's callbacks; replaces the previous subscriber. */
  subscribe(subscribed) {
    handlers = subscribed;
    subscribed.onConnectionChange('connected');
    for (const chunk of undelivered.splice(0)) subscribed.onChunk(chunk);
    return () => {
      if (handlers === subscribed) handlers = null;
    };
  },

  /**
   * @param {ChxMessage} message
   * @param {{ signal: AbortSignal }} options Aborted when the user stops the turn.
   */
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
      builder: new MessageBuilder(sessionId, AGENT_ID, { live: true }),
      controller: /** @type {ReadableStreamDefaultController<ChxChunk>} */ (controller),
      started: false,
    };
    turns.set(sessionId, turn);
    signal.addEventListener(
      'abort',
      () => {
        if (turns.get(sessionId) !== turn) return;
        stopped.add(sessionId);
        sessionCancel(sessionId).catch((err) => app.log('warn', `cancel failed: ${err}`));
        endTurn(sessionId, { cancelled: true });
      },
      { once: true },
    );
    try {
      touchSession(sessionId, await sessionSendPrompt(sessionId, prompt));
    } catch (err) {
      if (turns.get(sessionId) === turn) turns.delete(sessionId);
      throw err;
    }
    return stream;
  },
};
