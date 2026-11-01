import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import errorIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import permissionIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import queuedIcon from '@material-design-icons/svg/outlined/hourglass_empty.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { sessions } from '../../hooks/sessions/sessions.js';
import styles from './session-status.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').SessionIndicator} SessionIndicator */
/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

const ICONS = { permission: permissionIcon, error: errorIcon, queued: queuedIcon, terminal: terminalIcon };

/**
 * @tag acp-session-status
 * @summary A session's status icon, the same in its header and its list row, worked out from the session: permission, error, a spinner while the agent works (here, in its terminal or in another app), an hourglass while its turn waits for the project, a terminal while its CLI runs it. Nothing shows when there's nothing to say.
 */
export class AcpSessionStatus extends LitElement {
  static properties = {
    session: { attribute: false },
    permissionPending: { type: Boolean, attribute: 'permission-pending' },
    now: { attribute: false },
    quiet: { type: Boolean },
    indicator: { reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Session | null} */
    this.session = null;
    /** @type {boolean} A permission request of the session waits for the user. */
    this.permissionPending = false;
    /** @type {number | null} ms; what "active in another app" is judged against, the current time while `null`. */
    this.now = null;
    /** @type {boolean} Leave an idle terminal session unmarked (a list row; its header still says it). */
    this.quiet = false;
    /** @type {SessionIndicator | null} Derived from the rest; nothing shows for `null`. */
    this.indicator = null;
  }

  /** @param {Map<PropertyKey, unknown>} changed */
  willUpdate(changed) {
    if (!['session', 'permissionPending', 'now', 'quiet'].some((name) => changed.has(name))) return;
    const session = this.session;
    const indicator = session
      ? sessions.sessionIndicator(
          session.status,
          this.permissionPending,
          sessions.isActiveElsewhere(session, this.now ?? Date.now()),
          session.inTerminal === true,
        )
      : null;
    this.indicator = this.quiet && indicator === 'terminal' ? null : indicator;
  }

  #renderGlyph() {
    switch (this.indicator) {
      case 'running':
      case 'elsewhere':
      case 'terminal-working':
        return html`<md-progress-circular class="acp-session-status__spinner"></md-progress-circular>`;
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
    const label = sessions.INDICATOR_LABELS[indicator];
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
