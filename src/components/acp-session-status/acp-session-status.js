import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import errorIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import permissionIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import { INDICATOR_LABELS } from '../../models/sessions.js';
import styles from './acp-session-status.css?inline';

/** @typedef {import('../../models/types.js').SessionIndicator} SessionIndicator */

const ICONS = { permission: permissionIcon, error: errorIcon };

/**
 * @tag acp-session-status
 * @summary A session's status icon, the same in its header and its list row: permission, error, a spinner while the agent works, a dot for new output.
 */
export class AcpSessionStatus extends LitElement {
  static properties = {
    indicator: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {SessionIndicator | null} Nothing shows for `null`. */
    this.indicator = null;
  }

  #renderGlyph() {
    switch (this.indicator) {
      case 'running':
        return html`<md-progress-circular class="acp-session-status__spinner"></md-progress-circular>`;
      case 'unread':
        return html`<span class="acp-session-status__dot"></span>`;
      case 'permission':
      case 'error':
        return html`<md-icon class="acp-session-status__glyph">${unsafeSVG(ICONS[this.indicator])}</md-icon>`;
      default:
        return nothing;
    }
  }

  render() {
    const indicator = this.indicator;
    if (indicator === null) return nothing;
    const label = INDICATOR_LABELS[indicator];
    return html`<span
      class="acp-session-status__icon acp-session-status__icon_${indicator}"
      role="img"
      aria-label=${label}
      title=${label}
      >${this.#renderGlyph()}</span
    >`;
  }
}

customElements.define('acp-session-status', AcpSessionStatus);
