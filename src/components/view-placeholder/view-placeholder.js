import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import styles from './view-placeholder.css?inline';

/**
 * @tag acp-view-placeholder
 * @summary Icon, heading and text standing in for a view that isn't built yet.
 */
export class AcpViewPlaceholder extends LitElement {
  static properties = {
    icon: {},
    heading: {},
    text: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} SVG markup. */
    this.icon = '';
    /** @type {string} */
    this.heading = '';
    /** @type {string} */
    this.text = '';
  }

  render() {
    return html`
      <md-icon class="acp-view-placeholder__icon">${unsafeSVG(this.icon)}</md-icon>
      <h2 class="acp-view-placeholder__heading">${this.heading}</h2>
      <p class="acp-view-placeholder__text">${this.text}</p>
    `;
  }
}

customElements.define('acp-view-placeholder', AcpViewPlaceholder);
