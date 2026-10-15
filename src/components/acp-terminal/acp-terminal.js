import { LitElement, html } from 'lit';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import '../acp-view-placeholder/acp-view-placeholder.js';
import styles from './acp-terminal.css?inline';

/**
 * @tag acp-terminal
 * @summary The Terminal tab (mock).
 */
export class AcpTerminal extends LitElement {
  static styles = styles;

  render() {
    return html`<acp-view-placeholder
      class="acp-terminal__placeholder"
      .icon=${terminalIcon}
      heading="Terminal"
      text="Not implemented yet."
    ></acp-view-placeholder>`;
  }
}

customElements.define('acp-terminal', AcpTerminal);
