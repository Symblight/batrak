import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/progress-circular';
import styles from './panel.css?inline';

/**
 * @tag acp-panel
 * @summary A surface that stacks its children: the column box (background, rounded, clipped) or, as `variant="window"`, the app's whole window. A child in the `header` slot keeps its size, any other fills the rest, a `hidden` one drops out; `loading` shows a spinner after them.
 */
export class AcpPanel extends LitElement {
  static properties = {
    variant: { type: String, reflect: true },
    loading: { type: Boolean, reflect: true },
    loadingLabel: { type: String, attribute: 'loading-label' },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {'column' | 'window'} */
    this.variant = 'column';
    /** @type {boolean} */
    this.loading = false;
    /** @type {string} Accessible name of the spinner. */
    this.loadingLabel = 'Loading';
  }

  render() {
    return html`<slot name="header"></slot>
      <slot></slot>
      ${this.loading
        ? html`<div class="acp-panel__loading">
            <md-progress-circular class="acp-panel__spinner" aria-label=${this.loadingLabel}></md-progress-circular>
          </div>`
        : nothing}`;
  }
}

customElements.define('acp-panel', AcpPanel);
