import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import syncIcon from '@material-design-icons/svg/outlined/sync.svg?raw';
import { syncSummary } from '../../models/sessions.js';
import styles from './acp-session-sync.css?inline';

/** @typedef {import('../../models/types.js').SessionSync} SessionSync */

/**
 * @tag acp-session-sync
 * @summary The project's sync of its sessions with its agents: Resync, spinning while it runs, its tooltip saying when it last synced and how each agent did, a dot when an agent needs the user.
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
    const { label, lines, warn } = syncSummary(this.sync, Date.now());
    return html`<md-icon-button
        class="acp-session-sync__button"
        title=${[label, ...lines].join('\n')}
        aria-label="Resync sessions"
        @click=${this.#onClick}
      >
        <md-icon class=${classMap({ 'acp-session-sync__icon': true, 'acp-session-sync__icon_running': this.sync.running })}
          >${unsafeSVG(syncIcon)}</md-icon
        >
      </md-icon-button>
      ${warn ? html`<span class="acp-session-sync__warning" aria-hidden="true"></span>` : nothing}`;
  }
}

customElements.define('acp-session-sync', AcpSessionSync);
