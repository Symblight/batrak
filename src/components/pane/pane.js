import { LitElement, html } from 'lit';
import styles from './pane.css?inline';

/**
 * @tag acp-pane
 * @summary One item of a split: sized by `--acp-pane-flex`, `-width`, `-min-width` and `-max-width`, or in a column split `-height`, `-min-height` and `-max-height` (set inline by its user) and by the inline `flex-basis` and `width` (`height`) of a resize. `hidden` collapses it to nothing, its gap with it on the side of `edge` (`start` or `end`; for panes of a row, not of a column split), and showing it again grows it back; without `edge` it just disappears.
 */
export class AcpPane extends LitElement {
  static properties = {
    edge: { type: String, reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {'start' | 'end' | null} The side whose gap collapses with it. */
    this.edge = null;
  }

  render() {
    return html`<slot></slot>`;
  }
}

customElements.define('acp-pane', AcpPane);
