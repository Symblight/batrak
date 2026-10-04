import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/progress-circular';
import '../acp-chat/acp-chat.js';
import '../acp-welcome/acp-welcome.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $openingPath, $workspace } from '../../stores/workspace.js';
import styles from './acp-agent-column.css?inline';

/**
 * @tag acp-agent-column
 * @summary Agent chat for the opened project; the welcome screen until one is opened, a spinner while one opens.
 */
export class AcpAgentColumn extends LitElement {
  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });

  render() {
    const opening = this.#openingPath.value !== null;
    // Hidden rather than removed while a project opens, so the chat keeps its state.
    return html`
      ${this.#workspace.value !== null
        ? html`<acp-chat class="acp-agent-column__chat" ?hidden=${opening}></acp-chat>`
        : html`<acp-welcome class="acp-agent-column__welcome" ?hidden=${opening}></acp-welcome>`}
      ${opening
        ? html`<div class="acp-agent-column__loading">
            <md-progress-circular class="acp-agent-column__spinner" aria-label="Opening project"></md-progress-circular>
          </div>`
        : nothing}
    `;
  }
}

customElements.define('acp-agent-column', AcpAgentColumn);
