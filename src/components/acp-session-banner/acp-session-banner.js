import { LitElement, html, nothing } from 'lit';
import { OPTION_VARIANTS } from '@symblight/chat/agent';
import '@symblight/wc-material/button';
import '@symblight/wc-material/tooltip';
import { ownSignIns } from '../../models/agents.js';
import styles from './acp-session-banner.css?inline';

/** @typedef {import('../../models/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../models/types.js').SessionNotice} SessionNotice */
/** @typedef {import('../../models/types.js').SessionSignIn} SessionSignIn */
/** @typedef {import('../../models/types.js').SignInRun} SignInRun */
/** @typedef {'open-log' | 'restart' | 'turn-on-agent' | 'dismiss-notice' | 'open-terminal' | 'show-login'} SessionAction */

/** @type {Record<string, string>} ACP `PermissionOptionKind` → `md-button` variant. */
const VARIANTS = OPTION_VARIANTS;

/**
 * @tag acp-session-banner
 * @summary Above the composer: the agent's permission request with its options, else the session's notice (starting, error with Restart and Open log (Turn on for an agent the user turned off), stopped with Resume, agents.json changed the running agent with Restart, a queued turn with the session it waits for, another turn changing the same file, the agent asking to sign in with its ways and Retry, or information).
 * @fires acp-permission-respond `{ requestId, optionId }`
 * @fires acp-agent-sign-in `{ agentId, methodId }` `methodId: null` is Retry (only checks).
 * @fires acp-agent-sign-in-cancel `{ agentId }`
 * @fires acp-session-select `{ sessionId }` to show the session a queued turn waits for
 * @fires acp-session-action `{ action }` A `SessionAction` on the active session.
 */
export class AcpSessionBanner extends LitElement {
  static properties = {
    permission: { attribute: false },
    notice: { attribute: false },
    signInRun: { attribute: false },
    loginHere: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {PermissionRequest | null} The active session's pending request. */
    this.permission = null;
    /** @type {SessionNotice | null} The active session's notice. */
    this.notice = null;
    /** @type {SignInRun | null} The sign-in running or failed for the notice's agent. */
    this.signInRun = null;
    /** @type {boolean} The run's login terminal is this window's (another window's it can't show). */
    this.loginHere = false;
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

  /** @param {SessionSignIn} signIn */
  #renderSignIn(signIn) {
    const { agentId } = signIn;
    if (this.signInRun?.state === 'waiting') {
      return html`${this.signInRun.terminal && this.loginHere
          ? html`<md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => this.#act('show-login')}>
              Show terminal
            </md-button>`
          : nothing}
        <md-button
          slot="actions"
          class="acp-session-banner__action"
          variant="text"
          @click=${() => this.#emit('acp-agent-sign-in-cancel', { agentId })}
          >Cancel</md-button
        >`;
    }
    const own = ownSignIns(signIn.methods);
    const signInWith = (/** @type {string | null} */ methodId) => this.#emit('acp-agent-sign-in', { agentId, methodId });
    return html`
      ${own.map(
        (method) => html`<md-button
            id="acp-session-banner-method-${method.id}"
            slot="actions"
            class="acp-session-banner__action"
            variant="tonal"
            @click=${() => signInWith(method.id)}
            >${method.name}</md-button
          >
          ${method.description
            ? html`<md-tooltip slot="actions" for="acp-session-banner-method-${method.id}" show-delay="800"
                >${method.description}</md-tooltip
              >`
            : nothing}`,
      )}
      ${own.length
        ? nothing
        : html`<md-button slot="actions" class="acp-session-banner__action" variant="text" @click=${() => this.#act('open-terminal')}>
            Open terminal
          </md-button>`}
      <md-button
        id="acp-session-banner-retry"
        slot="actions"
        class="acp-session-banner__action"
        variant="text"
        @click=${() => signInWith(null)}
        >Retry</md-button
      >
      <md-tooltip slot="actions" for="acp-session-banner-retry" show-delay="800">Check whether you're signed in now</md-tooltip>
    `;
  }

  /**
   * @param {SessionNotice} notice
   * @returns {string}
   */
  #signInLabel(notice) {
    const signIn = /** @type {SessionSignIn} */ (notice.signIn);
    const run = this.signInRun;
    if (run?.state === 'waiting' && run.terminal) {
      const where = this.loginHere ? '' : ' of the window that started it';
      return `Signing in to ${signIn.agentName}… Finish in the ${run.terminal.title} terminal${where}.`;
    }
    if (run?.state === 'waiting') return `Signing in to ${signIn.agentName}… Finish in your browser if it opened.`;
    if (run?.state === 'failed') return `Signing in to ${signIn.agentName} failed: ${run.message ?? 'unknown error'}`;
    if (!ownSignIns(signIn.methods).length) return `${signIn.agentName} needs you to sign in. Run its login in a terminal, then Retry.`;
    return notice.message;
  }

  /** @param {SessionNotice} notice */
  #renderNoticeActions(notice) {
    if (notice.kind === 'sign-in' && notice.signIn) return this.#renderSignIn(notice.signIn);
    if (notice.kind === 'error') {
      return html`
        <md-button slot="actions" class="acp-session-banner__action" variant="text" @click=${() => this.#act('open-log')}>
          Open log
        </md-button>
        ${notice.offAgent
          ? html`<md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => this.#act('turn-on-agent')}>
              Turn on
            </md-button>`
          : html`<md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => this.#act('restart')}>
              Restart
            </md-button>`}
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
          id="acp-session-banner-resume"
          slot="actions"
          class="acp-session-banner__action"
          variant="text"
          @click=${() => this.#act('restart')}
          >Resume</md-button
        >
        <md-tooltip slot="actions" for="acp-session-banner-resume" show-delay="800"
          >Start the agent now; it restores the conversation where it can</md-tooltip
        >`;
    }
    return nothing;
  }

  render() {
    const request = this.permission;
    const notice = this.notice;
    const shown = request !== null || notice !== null;
    const signingIn = !request && notice?.kind === 'sign-in' && notice.signIn !== undefined;
    const label = request?.title ?? (notice && signingIn ? this.#signInLabel(notice) : notice?.message) ?? '';
    const failed = notice?.kind === 'error' || (signingIn && this.signInRun?.state === 'failed');
    const variant = !request && failed ? 'danger' : 'default';
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
