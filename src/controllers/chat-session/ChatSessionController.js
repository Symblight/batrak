import { StoreController } from '../store/StoreController.js';
import { sessionController } from '../../services/session-controller.js';
import { $activeSession, $activeSessionId, $draftSessions, $sessions } from '../../stores/sessions.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').LitElement} LitElement */
/** @typedef {import('@symblight/chat').ChxChat} ChxChat */

/**
 * @typedef {Object} ChatSessionConfig
 * @property {() => ChxChat | null} chat The host's `<chx-chat>`.
 */

/**
 * What a session left in the composer. Text only: chips go back as their labels, since `setText()` is the
 * only way in.
 * @typedef {Object} ComposerDraft
 * @property {string} text
 * @property {File[]} files
 */

const TITLE_LENGTH = 60;

/** @param {string} text The first message. */
function titleOf(text) {
  const line = text.trim().split('\n', 1)[0].trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line || 'New session';
}

/**
 * Binds the host's `<chx-chat>` to the sessions: the active session is its conversation (every session's
 * messages stay cached in the chat, replies to a hidden one keep streaming), a draft's first message
 * starts it (and comes back into the composer when the session is refused), and each session keeps
 * what was left in the composer. Statuses come from the backend's session events.
 * @implements {ReactiveController}
 */
export class ChatSessionController {
  /** @type {LitElement} */
  #host;
  /** @type {ChatSessionConfig} */
  #config;
  /** @type {Map<string, ComposerDraft>} Unsent composer content by session id. */
  #drafts = new Map();
  /** @type {StoreController<string | null>} */
  #activeId;
  /** @type {StoreController<import('../../models/types.js').Session | null>} */
  #session;

  /**
   * @param {LitElement} host
   * @param {ChatSessionConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    this.#activeId = new StoreController(host, {
      store: $activeSessionId,
      onChange: (id, oldId) => this.#onSwitch(id, oldId),
    });
    this.#session = new StoreController(host, { store: $activeSession });
    // A removed session's messages leave the chat's cache.
    new StoreController(host, {
      store: $sessions,
      onChange: (sessions, old) => {
        const chat = this.#config.chat();
        if (!chat || !old) return;
        for (const gone of old.filter((s) => !sessions.some((n) => n.id === s.id))) {
          if (!(gone.id in $draftSessions.get())) chat.store.clear(gone.id);
        }
      },
    });
    host.addController(this);
  }

  /** For `<chx-chat>`'s `activeConversationId`. */
  get conversationId() {
    return this.#activeId.value ?? undefined;
  }

  /** The active session is a draft with no message yet: the chat shows only its composer. */
  get empty() {
    return this.#session.value === null;
  }

  hostConnected() {
    const root = this.#host.renderRoot;
    // Capture: the session must exist before `<chx-chat>` handles the send and starts the turn.
    root.addEventListener('chx-send-message', this.#onSend, { capture: true });
    root.addEventListener('chx-delivery-end', this.#onDeliveryEnd);
  }

  hostDisconnected() {
    const root = this.#host.renderRoot;
    root.removeEventListener('chx-send-message', this.#onSend, { capture: true });
    root.removeEventListener('chx-delivery-end', this.#onDeliveryEnd);
  }

  /** @param {Event} e */
  #onSend = (e) => {
    const id = this.#activeId.value;
    if (id === null || this.#session.value !== null) return;
    sessionController.start(id, titleOf(/** @type {CustomEvent<{ value: string }>} */ (e).detail.value));
  };

  /**
   * A draft's first message the backend refused: the draft shows only its composer, so the message
   * goes back into it.
   * @param {Event} e
   */
  #onDeliveryEnd = (e) => {
    const { conversationId, outcome } = /** @type {CustomEvent<{ conversationId?: string, outcome: string }>} */ (e)
      .detail;
    const chat = this.#config.chat();
    if (outcome !== 'failed' || !conversationId || !chat || !(conversationId in $draftSessions.get())) return;
    const sent = chat.store.getMessages(conversationId).filter((m) => m.own).at(-1);
    chat.store.clear(conversationId);
    if (sent && this.#activeId.value === conversationId && chat.input.isEmpty()) {
      chat.input.setText(sent.parts.map((p) => p.text ?? p.label ?? '').join(''));
    }
  };

  /**
   * Keeps the composer's content for the session left, and puts back the shown one's.
   * @param {string | null} id
   * @param {string | null | undefined} oldId `undefined` on connect.
   */
  async #onSwitch(id, oldId) {
    // Runs before the re-render, so the composer still holds the old session's content.
    const chat = this.#config.chat();
    if (chat && oldId) {
      const draft = { text: chat.input.getValue().value, files: chat.attachments.getFiles() };
      if (draft.text.trim() || draft.files.length) this.#drafts.set(oldId, draft);
      else this.#drafts.delete(oldId);
    }
    if (id === null) return;
    await this.#host.updateComplete;
    const shown = this.#config.chat();
    if (!shown || this.#activeId.value !== id) return;
    await shown.updateComplete;
    const draft = this.#drafts.get(id);
    this.#drafts.delete(id);
    shown.input.setText(draft?.text ?? '');
    shown.attachments.clear();
    if (draft?.files.length) shown.attachments.add(draft.files);
    if (oldId !== undefined) shown.input.focusEnd();
  }
}
