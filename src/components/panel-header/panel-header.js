import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import styles from './panel-header.css?inline';

/**
 * @tag acp-panel-header
 * @summary A panel's title row, with an optional icon action (its label is its tooltip).
 * @fires acp-panel-header-action `null`
 */
export class AcpPanelHeader extends LitElement {
  static properties = {
    heading: { type: String },
    action: { attribute: false },
    actionDisabled: { type: Boolean, attribute: 'action-disabled' },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.heading = '';
    /** @type {{ icon: string, label: string, tooltip?: string } | null} An icon button at the end; `icon` is SVG markup, `tooltip` defaults to `label`. */
    this.action = null;
    /** @type {boolean} */
    this.actionDisabled = false;
  }

  #onAction() {
    this.dispatchEvent(new CustomEvent('acp-panel-header-action', { detail: null, bubbles: true, composed: true }));
  }

  render() {
    const action = this.action;
    return html`<h2 class="acp-panel-header__title">${this.heading}</h2>
      ${action
        ? html`<md-icon-button
              id="acp-panel-header-action"
              class="acp-panel-header__action"
              aria-label=${action.label}
              ?disabled=${this.actionDisabled}
              @click=${this.#onAction}
            >
              <md-icon class="acp-panel-header__action-icon">${unsafeSVG(action.icon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-panel-header-action" show-delay="800">${action.tooltip ?? action.label}</md-tooltip>`
        : nothing}`;
  }
}

customElements.define('acp-panel-header', AcpPanelHeader);
