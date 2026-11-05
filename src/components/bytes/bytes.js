import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/tooltip';

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** Gives each instance a tooltip anchor of its own: the ids share their parent's root. */
let count = 0;

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
 * @summary A byte count shown in the largest fitting unit (`1.5 KB`); the exact count is its tooltip. Light DOM.
 */
export class AcpBytes extends LitElement {
  static properties = {
    value: { type: Number },
  };

  /** @type {string} */
  #id = `acp-bytes-${++count}`;

  constructor() {
    super();
    /** @type {number | null} Byte count; nothing shows until it is a finite number. */
    this.value = null;
  }

  /** Light DOM: in its parent's tree; the host is an inline element already. */
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    this.style.fontVariantNumeric = 'tabular-nums';
    super.connectedCallback();
  }

  render() {
    const value = this.value;
    if (value === null || !Number.isFinite(value)) return nothing;
    return html`<span id=${this.#id} class="acp-bytes__value">${format(value)}</span>
      <md-tooltip for=${this.#id} show-delay="800">${value.toLocaleString('en-US')} bytes</md-tooltip>`;
  }
}

customElements.define('acp-bytes', AcpBytes);
