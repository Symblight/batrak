import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import cloudDownloadIcon from '@material-design-icons/svg/outlined/cloud_download.svg?raw';
import styles from './acp-welcome.css?inline';

/**
 * @tag acp-welcome
 * @summary Shown while no project is open: open a local folder or a GitHub repository.
 * @fires acp-open-local `null`
 * @fires acp-open-repository `null`
 */
export class AcpWelcome extends LitElement {
  static styles = styles;

  #openLocal() {
    this.dispatchEvent(new CustomEvent('acp-open-local', { detail: null, bubbles: true, composed: true }));
  }

  #openRepository() {
    this.dispatchEvent(new CustomEvent('acp-open-repository', { detail: null, bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="acp-welcome__content">
        <h2 class="acp-welcome__title">What are we working on today?</h2>
        <p class="acp-welcome__subtitle">Open a project to start an agent session.</p>
        <div class="acp-welcome__actions">
          <md-button class="acp-welcome__action" variant="filled" @click=${this.#openLocal}>
            <md-icon slot="icon" class="acp-welcome__action-icon">${unsafeSVG(folderOpenIcon)}</md-icon>
            Open local project
          </md-button>
          <md-button class="acp-welcome__action" variant="outlined" @click=${this.#openRepository}>
            <md-icon slot="icon" class="acp-welcome__action-icon">${unsafeSVG(cloudDownloadIcon)}</md-icon>
            Open GitHub repository
          </md-button>
        </div>
      </div>
    `;
  }
}

customElements.define('acp-welcome', AcpWelcome);
