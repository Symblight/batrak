import { LitElement, html } from 'lit';
import styles from './split.css?inline';

/**
 * @tag acp-split
 * @summary A row of panes with the gap between them, filling its parent. Give a resize handle the `acp-split__handle` class and it sits in the gap.
 */
export class AcpSplit extends LitElement {
  static styles = styles;

  render() {
    return html`<slot></slot>`;
  }
}

customElements.define('acp-split', AcpSplit);
