import { LitElement, html } from 'lit';
import styles from './marked-text.css?inline';

/**
 * @tag acp-marked-text
 * @summary A text with some ranges of it marked, as a search marks what it matched.
 */
export class AcpMarkedText extends LitElement {
  static properties = {
    text: { type: String },
    ranges: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.text = '';
    /** @type {readonly (readonly [number, number])[]} UTF-16 ranges of `text`, in order. */
    this.ranges = [];
  }

  render() {
    /** @type {unknown[]} */
    const parts = [];
    let at = 0;
    for (const [start, end] of this.ranges) {
      parts.push(this.text.slice(at, start), html`<mark class="acp-marked-text__mark">${this.text.slice(start, end)}</mark>`);
      at = end;
    }
    parts.push(this.text.slice(at));
    return parts;
  }
}

customElements.define('acp-marked-text', AcpMarkedText);
