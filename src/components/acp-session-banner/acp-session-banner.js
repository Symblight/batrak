import { LitElement, html, nothing } from 'lit';
import { OPTION_VARIANTS } from '@symblight/chat/agent';
import '@symblight/wc-material/button';
import { StoreController } from '../../controllers/store/StoreController.js';
import { agentConfig } from '../../services/agent-config.js';
import { sessionController } from '../../services/session-controller.js';
import { $activeSessionId } from '../../stores/sessions.js';
import { $activeNotice, $activePermission } from '../../stores/session-runtime.js';
import styles from './acp-session-banner.css?inline';

/** @typedef {import('../../models/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../models/types.js').SessionNotice} SessionNotice */

/** @type {Record<string, string>} ACP `PermissionOptionKind` → `md-button` variant. */
const VARIANTS = OPTION_VARIANTS;

/**
 * @tag acp-session-banner
 * @summary Above the composer: the agent's permission request with its options, else the session's notice (starting, error with Restart and Open log, an untrusted project agent with Trust and start, stopped with Resume, or information).
 */
export class AcpSessionBanner extends LitElement {
  static styles = styles;

  #sessionId = new StoreController(this, { store: $activeSessionId });
  #permission = new StoreController(this, { store: $activePermission });
  #notice = new StoreController(this, { store: $activeNotice });

  /**
   * @param {string} id
   * @param {PermissionRequest} request
   */
  #renderPermission(id, request) {
    return request.options.map(
      (option) => html`<md-button
        slot="actions"
        class="acp-session-banner__action"
        variant=${VARIANTS[option.kind] ?? 'text'}
        @click=${() => sessionController.respondPermission(id, request.requestId, option.optionId)}
        >${option.name}</md-button
      >`,
    );
  }

  /**
   * @param {string} id
   * @param {SessionNotice} notice
   */
  #renderNoticeActions(id, notice) {
    if (notice.kind === 'error') {
      return html`
        <md-button slot="actions" class="acp-session-banner__action" variant="text" @click=${() => sessionController.openLog(id)}>
          Open log
        </md-button>
        <md-button slot="actions" class="acp-session-banner__action" variant="tonal" @click=${() => sessionController.restart(id)}>
          Restart
        </md-button>
      `;
    }
    if (notice.kind === 'untrusted') {
      return html`
        <md-button slot="actions" class="acp-session-banner__action" variant="text" @click=${() => agentConfig.openFile()}>
          Open agents.json
        </md-button>
        <md-button
          slot="actions"
          class="acp-session-banner__action"
          variant="tonal"
          @click=${() => sessionController.trustAndStart(id)}
          >Trust and start</md-button
        >
      `;
    }
    if (notice.kind === 'stopped') {
      return html`<md-button
        slot="actions"
        class="acp-session-banner__action"
        variant="text"
        title="Start the agent now; it restores the conversation where it can"
        @click=${() => sessionController.restart(id)}
        >Resume</md-button
      >`;
    }
    return nothing;
  }

  render() {
    const id = this.#sessionId.value;
    const request = this.#permission.value;
    const notice = this.#notice.value;
    const shown = id !== null && (request !== null || notice !== null);
    const label = request?.title ?? notice?.message ?? '';
    const variant = !request && (notice?.kind === 'error' || notice?.kind === 'untrusted') ? 'danger' : 'default';
    // Kept mounted and only hidden: its live region announces a new label reliably.
    return html`<chx-input-mode-banner
      class="acp-session-banner__banner"
      ?hidden=${!shown}
      .label=${label}
      .variant=${variant}
      ?dismissible=${!request && notice?.kind === 'info'}
      @chx-input-mode-banner-dismiss=${() => id !== null && sessionController.dismissNotice(id)}
    >
      ${id === null ? nothing : request ? this.#renderPermission(id, request) : notice ? this.#renderNoticeActions(id, notice) : nothing}
    </chx-input-mode-banner>`;
  }
}

customElements.define('acp-session-banner', AcpSessionBanner);
