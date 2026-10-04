import { LitElement, html } from 'lit';
import '../acp-chat/acp-chat.js';
import '../acp-welcome/acp-welcome.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $workspace } from '../../stores/workspace.js';
import styles from './acp-agent-column.css?inline';

/**
 * @tag acp-agent-column
 * @summary Agent chat for the opened project; the welcome screen until one is opened.
 */
export class AcpAgentColumn extends LitElement {
  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });

  render() {
    return this.#workspace.value !== null
      ? html`<acp-chat class="acp-agent-column__chat"></acp-chat>`
      : html`<acp-welcome class="acp-agent-column__welcome"></acp-welcome>`;
  }
}

customElements.define('acp-agent-column', AcpAgentColumn);
