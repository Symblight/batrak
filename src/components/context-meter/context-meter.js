import { LitElement, html, nothing } from 'lit';
import { flip, offset, shift } from '@floating-ui/dom';
import '@symblight/wc-material/button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/progress-linear';
import '@symblight/wc-material/tooltip';
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import styles from './context-meter.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').ContextUsage} ContextUsage */

/**
 * How the meter is coloured for a share of the window used.
 * @param {number} share 0 to 1.
 */
function levelOf(share) {
  return share >= 0.9 ? 'critical' : share >= 0.7 ? 'warning' : 'normal';
}

/** @param {number} tokens */
function formatTokens(tokens) {
  if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * @tag acp-context-meter
 * @summary How full the agent's context window is (ACP `usage_update`): a ring with the percentage in its tooltip, the tokens in a popover on click; an empty ring until the agent reports it.
 */
export class AcpContextMeter extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    usage: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {boolean} The details popover is showing. */
    this.open = false;
    /** @type {ContextUsage | null} `null` until the agent reports it. */
    this.usage = null;
  }

  /** When light dismiss last closed the popover: the press on the button that caused it mustn't reopen it. */
  #closedAt = 0;

  get #popover() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-context-meter__popover'));
  }

  get #button() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-context-meter__button'));
  }

  // Constructed after the fields above: the controller reads them on every update.
  #floating = new FloatingController(this, {
    floating: () => (this.open ? this.#popover : null),
    reference: () => this.#button,
    placement: 'top-end',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });

  #onClick = () => {
    if (performance.now() - this.#closedAt < 300) return;
    this.#popover?.togglePopover();
  };

  // Before the popover shows, so it is placed before its first paint.
  #onToggle = (/** @type {Event} */ e) => {
    this.open = /** @type {ToggleEvent} */ (e).newState === 'open';
    if (!this.open) this.#closedAt = performance.now();
  };

  /** @param {ContextUsage} usage */
  #renderDetails(usage) {
    const share = usage.size > 0 ? Math.min(1, usage.used / usage.size) : 0;
    const level = levelOf(share);
    return html`
      <div class="acp-context-meter__row">
        <span class="acp-context-meter__title">Context</span>
        <span class="acp-context-meter__value">${formatTokens(usage.used)} / ${formatTokens(usage.size)}</span>
      </div>
      <md-progress-linear class="acp-context-meter__bar acp-context-meter__bar_${level}" .value=${share}></md-progress-linear>
    `;
  }

  render() {
    const usage = this.usage;
    const share = usage && usage.size > 0 ? Math.min(1, usage.used / usage.size) : 0;
    const percent = Math.round(share * 100);
    const tooltip = usage
      ? `Context: ${percent}% used (${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens)`
      : 'Context usage: not reported yet';
    return html`
      <md-button
        id="acp-context-meter-button"
        class="acp-context-meter__button"
        variant="text"
        aria-label=${tooltip}
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${this.#onClick}
      >
        <md-progress-circular
          slot="icon"
          class="acp-context-meter__ring acp-context-meter__ring_${levelOf(share)}"
          .value=${share}
        ></md-progress-circular>
      </md-button>
      <md-tooltip for="acp-context-meter-button" show-delay="500" placement="top">${tooltip}</md-tooltip>
      <div class="acp-context-meter__popover" popover="auto" role="dialog" aria-label="Context usage" @beforetoggle=${this.#onToggle}>
        ${usage
          ? this.#renderDetails(usage)
          : html`<div class="acp-context-meter__row">
                <span class="acp-context-meter__title">Context</span>
                <span class="acp-context-meter__value">Not reported yet</span>
              </div>
              <p class="acp-context-meter__pending">The agent reports it with its replies.</p>`}
        <p class="acp-context-meter__note">Plan limits aren’t reported over ACP. Check them in the agent’s own app.</p>
      </div>
    `;
  }
}

customElements.define('acp-context-meter', AcpContextMeter);
