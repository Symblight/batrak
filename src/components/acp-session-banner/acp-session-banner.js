import { LitElement, html, nothing } from 'lit';
import { OPTION_VARIANTS } from '@symblight/chat/agent';
import '@symblight/wc-material/button';
import styles from './acp-session-banner.css?inline';

/** @typedef {import('../../models/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../models/types.js').SessionNotice} SessionNotice */
/** @typedef {'open-log' | 'restart' | 'dismiss-notice'} SessionAction */

/** @type {Record<string, string>} ACP `PermissionOptionKind` → `md-button` variant. */
const VARIANTS = OPTION_VARIANTS;

/**
 * @tag acp-session-banner
 * @summary Above the composer: the agent's permission request with its options, else the session's notice (starting, error with Restart and Open log, stopped with Resume, agents.json changed the running agent with Restart, a queued turn with the session it waits for, another turn changing the same file, or information).
 * @fires acp-permission-respond `{ requestId, optionId }`
 * @fires acp-session-select `{ sessionId }` to show the session a queued turn waits for
 * @fires acp-session-action `{ action }` A `SessionAction` on the active session.
 */
export class AcpSessionBanner extends LitElement {
  static properties = {
    permission: { attribute: false },
    notice: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {PermissionRequest | null} The active session's pending request. */
    this.permission = null;
    /** @type {SessionNotice | null} The active session's notice. */
    this.notice = null;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {SessionAction} action */
  #act(action) {
    this.#emit('acp-session-action', { action });
  }

  /** @param {PermissionRequest} request */
  #renderPermission(request) {
    return request.options.map(
      (option) => html`<md-button
        slot="actions"
        class="acp-session-banner__action"
        variant=${VARIANTS[option.kind] ?? 'text'}
        @click=${() => this.#emit('acp-permission-respond', { requestId: request.requestId, optionId: option.optionId })}
        >${option.name}</md-button
      >`,
    );
  }

  /** @param {SessionNotice} notice */
  #renderNoticeActions(notice) {
    if (notice.kind === 'error') {
      return html`
        <md-button slot="actions" class="acp-session-banner__action" variant="text" @click=${() => this.#act('open-log')}>
          Open log
        </md-button>
        <md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => this.#act('restart')}>
          Restart
        </md-button>
      `;
    }
    if (notice.kind === 'outdated') {
      return html`<md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => this.#act('restart')}>
        Restart
      </md-button>`;
    }
    const holder = notice.kind === 'queued' ? notice.holder : undefined;
    if (holder) {
      return html`<md-button
        slot="actions"
        class="acp-session-banner__action"
        variant="text"
        @click=${() => this.#emit('acp-session-select', { sessionId: holder.id })}
        >Show session</md-button
      >`;
    }
    if (notice.kind === 'stopped') {
      return html`<md-button
        slot="actions"
        class="acp-session-banner__action"
        variant="text"
        title="Start the agent now; it restores the conversation where it can"
        @click=${() => this.#act('restart')}
        >Resume</md-button
      >`;
    }
    return nothing;
  }

  render() {
    const request = this.permission;
    const notice = this.notice;
    const shown = request !== null || notice !== null;
    const label = request?.title ?? notice?.message ?? '';
    const variant = !request && notice?.kind === 'error' ? 'danger' : 'default';
    // Kept mounted and only hidden: its live region announces a new label reliably.
    return html`<chx-input-mode-banner
      class="acp-session-banner__banner"
      ?hidden=${!shown}
      .label=${label}
      .variant=${variant}
      ?dismissible=${!request && (notice?.kind === 'info' || notice?.kind === 'outdated' || notice?.kind === 'overlap')}
      @chx-input-mode-banner-dismiss=${() => this.#act('dismiss-notice')}
    >
      ${request ? this.#renderPermission(request) : notice ? this.#renderNoticeActions(notice) : nothing}
    </chx-input-mode-banner>`;
  }
}

customElements.define('acp-session-banner', AcpSessionBanner);
