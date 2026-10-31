import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import errorIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import permissionIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import queuedIcon from '@material-design-icons/svg/outlined/hourglass_empty.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { INDICATOR_LABELS } from '../../models/sessions/sessions.js';
import styles from './session-status.css?inline';

/** @typedef {import('../../models/types/types.js').SessionIndicator} SessionIndicator */

const ICONS = { permission: permissionIcon, error: errorIcon, queued: queuedIcon, terminal: terminalIcon };

/**
 * @tag acp-session-status
 * @summary A session's status icon, the same in its header and its list row: permission, error, a spinner while the agent works (here, in its terminal or in another app), an hourglass while its turn waits for the project, a terminal while its CLI runs it, a dot for new output.
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
      case 'elsewhere':
      case 'terminal-working':
        return html`<md-progress-circular class="acp-session-status__spinner"></md-progress-circular>`;
      case 'unread':
        return html`<span class="acp-session-status__dot"></span>`;
      case 'permission':
      case 'error':
      case 'queued':
      case 'terminal':
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
        id="acp-session-status-icon"
        class="acp-session-status__icon acp-session-status__icon_${indicator}"
        role="img"
        aria-label=${label}
        >${this.#renderGlyph()}</span
      >
      <md-tooltip for="acp-session-status-icon" show-delay="800">${label}</md-tooltip>`;
  }
}

customElements.define('acp-session-status', AcpSessionStatus);
