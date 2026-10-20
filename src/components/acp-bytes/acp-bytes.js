import { LitElement, html, nothing } from 'lit';
import { Bytes } from './bytes.js';
import styles from './acp-bytes.css?inline';

/**
 * @tag acp-bytes
 * @summary A byte count shown in the largest fitting unit (`1.5 KB`); the exact count is its title.
 */
export class AcpBytes extends LitElement {
  static properties = {
    value: { type: Number },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {number | null} Byte count; nothing shows until it is a finite number. */
    this.value = null;
  }

  render() {
    const value = this.value;
    if (value === null || !Number.isFinite(value)) return nothing;
    return html`<span class="acp-bytes__value" title="${value.toLocaleString('en-US')} bytes">${new Bytes(value)}</span>`;
  }
}

customElements.define('acp-bytes', AcpBytes);
