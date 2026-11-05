import { LitElement, html } from 'lit';
import styles from './split.css?inline';

/**
 * @tag acp-split
 * @summary A row of panes (a column with `direction="column"`) with the gap between them, filling its parent; `flush` leaves out the padding of the window's edge, for a split inside a pane. Give a resize handle the `acp-split__handle` class and it sits in the gap.
 */
export class AcpSplit extends LitElement {
  static properties = {
    direction: { type: String, reflect: true },
    flush: { type: Boolean, reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {'row' | 'column'} */
    this.direction = 'row';
    /** @type {boolean} */
    this.flush = false;
  }

  render() {
    return html`<slot></slot>`;
  }
}

customElements.define('acp-split', AcpSplit);
