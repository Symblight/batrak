import { LitElement, html, nothing } from 'lit';
import { flip, offset, shift } from '@floating-ui/dom';
import '@symblight/wc-material/button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/progress-linear';
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $composer } from '../../stores/composer.js';
import styles from './acp-context-meter.css?inline';

/** @param {number} tokens */
function formatTokens(tokens) {
  if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * @tag acp-context-meter
 * @summary How full the agent's context window is (ACP `usage_update`): a ring and percent, tokens and cost in a popover on click.
 */
export class AcpContextMeter extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {boolean} The details popover is showing. */
    this.open = false;
  }

  #composer = new StoreController(this, { store: $composer });

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

  render() {
    const { usage } = this.#composer.value;
    if (!usage) return nothing;
    const share = usage.size > 0 ? Math.min(1, usage.used / usage.size) : 0;
    const percent = Math.round(share * 100);
    const level = percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal';
    return html`
      <md-button
        class="acp-context-meter__button"
        variant="text"
        title="Context: ${percent}% used"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${this.#onClick}
      >
        <md-progress-circular
          slot="icon"
          class="acp-context-meter__ring acp-context-meter__ring_${level}"
          .value=${share}
        ></md-progress-circular>
        <span class="acp-context-meter__percent">${percent}%</span>
      </md-button>
      <div class="acp-context-meter__popover" popover="auto" role="dialog" aria-label="Context usage" @beforetoggle=${this.#onToggle}>
        <div class="acp-context-meter__row">
          <span class="acp-context-meter__title">Context</span>
          <span class="acp-context-meter__value">${formatTokens(usage.used)} / ${formatTokens(usage.size)}</span>
        </div>
        <md-progress-linear
          class="acp-context-meter__bar acp-context-meter__bar_${level}"
          .value=${share}
        ></md-progress-linear>
        ${usage.cost
          ? html`<div class="acp-context-meter__row">
              <span class="acp-context-meter__label">Session cost</span>
              <span class="acp-context-meter__value">
                ${new Intl.NumberFormat(undefined, { style: 'currency', currency: usage.cost.currency }).format(
                  usage.cost.amount,
                )}
              </span>
            </div>`
          : nothing}
        <p class="acp-context-meter__note">Plan limits aren’t reported over ACP. Check them in the agent’s own app.</p>
      </div>
    `;
  }
}

customElements.define('acp-context-meter', AcpContextMeter);
