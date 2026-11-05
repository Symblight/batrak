import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import backIcon from '@material-design-icons/svg/outlined/arrow_back.svg?raw';
import stopIcon from '@material-design-icons/svg/outlined/stop_circle.svg?raw';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './subagent-bar.css?inline';

const { SUBAGENT_INDICATOR_LABELS, subagentIndicator, subagentLabel } = sessions;

/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */

/**
 * @tag acp-subagent-bar
 * @summary In place of the composer while a subagent's read-only chat is shown: the subagent, its status and its chat, Back to chat, and Stop while it runs and the agent lets it be stopped.
 * @fires acp-subagent-close `null` Back to the chat.
 * @fires acp-subagent-stop `{ subagentId }`
 */
export class AcpSubagentBar extends LitElement {
  static properties = {
    subagent: { attribute: false },
    chatTitle: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Subagent | null} */
    this.subagent = null;
    /** @type {string} The chat it works for. */
    this.chatTitle = '';
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  render() {
    const subagent = this.subagent;
    if (!subagent) return nothing;
    const indicator = subagentIndicator(subagent);
    const stoppable = subagent.cancellable && (indicator === 'running' || indicator === 'waiting');
    return html`<div class="acp-subagent-bar__bar">
      <md-icon-button id="acp-subagent-bar-back" aria-label="Back to chat" @click=${() => this.#emit('acp-subagent-close', null)}>
        <md-icon class="acp-subagent-bar__icon">${unsafeSVG(backIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-subagent-bar-back" show-delay="800">Back to chat</md-tooltip>
      <div class="acp-subagent-bar__text">
        <span class="acp-subagent-bar__name">${subagentLabel(subagent)}</span>
        <span class="acp-subagent-bar__meta">${SUBAGENT_INDICATOR_LABELS[indicator]} · subagent of ${this.chatTitle}</span>
      </div>
      ${stoppable
        ? html`<md-icon-button
              id="acp-subagent-bar-stop"
              aria-label="Stop subagent"
              @click=${() => this.#emit('acp-subagent-stop', { subagentId: subagent.id })}
            >
              <md-icon class="acp-subagent-bar__icon">${unsafeSVG(stopIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-subagent-bar-stop" show-delay="800">Stop subagent</md-tooltip>`
        : nothing}
    </div>`;
  }
}

customElements.define('acp-subagent-bar', AcpSubagentBar);
