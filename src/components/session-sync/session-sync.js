import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import syncIcon from '@material-design-icons/svg/outlined/sync.svg?raw';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './session-sync.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').SessionSync} SessionSync */

/**
 * @tag acp-session-sync
 * @summary The project's sync of its sessions with its agents: a compact Refresh button, a spinner in place of its icon while it runs, a short tooltip (how each agent did too while it runs or when one needs the user), a dot when an agent needs the user.
 * @fires acp-session-resync `null`
 */
export class AcpSessionSync extends LitElement {
  static properties = {
    sync: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {SessionSync | null} The active project's; nothing shows for `null`. */
    this.sync = null;
  }

  #onClick() {
    this.dispatchEvent(new CustomEvent('acp-session-resync', { detail: null, bubbles: true, composed: true }));
  }

  render() {
    if (this.sync === null) return nothing;
    const { label, lines, warn } = sessions.syncSummary(this.sync, Date.now());
    const tip = this.sync.running ? [label, ...lines] : ['Refresh sessions', ...(warn ? lines : [])];
    return html`<md-icon-button
        id="acp-session-sync-button"
        class="acp-session-sync__button"
        aria-label="Refresh sessions"
        @click=${this.#onClick}
      >
        ${this.sync.running
          ? html`<md-progress-circular class="acp-session-sync__spinner"></md-progress-circular>`
          : html`<md-icon class="acp-session-sync__icon">${unsafeSVG(syncIcon)}</md-icon>`}
      </md-icon-button>
      <md-tooltip for="acp-session-sync-button" show-delay="500" placement="bottom">
        ${tip.map((line) => html`<div class="acp-session-sync__line">${line}</div>`)}
      </md-tooltip>
      ${warn ? html`<span class="acp-session-sync__warning" aria-hidden="true"></span>` : nothing}`;
  }
}

customElements.define('acp-session-sync', AcpSessionSync);
