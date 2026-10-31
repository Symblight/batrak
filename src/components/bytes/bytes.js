import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/tooltip';
import styles from './bytes.css?inline';

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** @param {number} bytes */
function format(bytes) {
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${UNITS[i]}`;
}

/**
 * @tag acp-bytes
 * @summary A byte count shown in the largest fitting unit (`1.5 KB`); the exact count is its tooltip.
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
    return html`<span id="acp-bytes-value" class="acp-bytes__value">${format(value)}</span>
      <md-tooltip for="acp-bytes-value" show-delay="800">${value.toLocaleString('en-US')} bytes</md-tooltip>`;
  }
}

customElements.define('acp-bytes', AcpBytes);
