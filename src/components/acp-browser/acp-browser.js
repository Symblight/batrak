import { LitElement, html } from 'lit';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import '../acp-view-placeholder/acp-view-placeholder.js';
import styles from './acp-browser.css?inline';

/**
 * @tag acp-browser
 * @summary The Browser tab (mock).
 */
export class AcpBrowser extends LitElement {
  static styles = styles;

  render() {
    return html`<acp-view-placeholder
      class="acp-browser__placeholder"
      .icon=${languageIcon}
      heading="Browser"
      text="Not implemented yet."
    ></acp-view-placeholder>`;
  }
}

customElements.define('acp-browser', AcpBrowser);
