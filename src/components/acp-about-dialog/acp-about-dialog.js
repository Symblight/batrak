import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import '@symblight/wc-material/icon';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { aboutRows, loadAbout } from '../../services/about.js';
import { revealPath } from '../../services/ipc.js';
import { log } from '../../services/logger.js';
import { $about } from '../../stores/about.js';
import styles from './acp-about-dialog.css?inline';

/**
 * @tag acp-about-dialog
 * @summary About Brama: the app's version, what it runs on and its log files.
 */
export class AcpAboutDialog extends LitElement {
  static styles = styles;

  #about = new StoreController(this, { store: $about });

  async show() {
    loadAbout();
    await /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog')).show();
  }

  #close = () => {
    /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog')).close();
  };

  #showLogs = () => {
    const logDir = this.#about.value?.logDir;
    if (logDir) revealPath(logDir).catch((err) => log('warn', `showing logs failed: ${err}`));
  };

  render() {
    const about = this.#about.value;
    return html`<md-dialog class="acp-about-dialog__dialog">
      <div slot="headline" class="acp-about-dialog__headline">
        <img class="acp-about-dialog__logo" src="/favicon.svg" alt="" />
        <span class="acp-about-dialog__title">Brama</span>
        <span class="acp-about-dialog__subtitle">${about ? `Version ${about.version}` : nothing}</span>
      </div>
      ${about
        ? html`<dl class="acp-about-dialog__rows">
            ${aboutRows(about).map(
              ([label, value]) => html`<dt class="acp-about-dialog__label">${label}</dt>
                <dd class="acp-about-dialog__value">${value}</dd>`,
            )}
          </dl>`
        : nothing}
      <div slot="footer" class="acp-about-dialog__footer">
        <md-button class="acp-about-dialog__action" variant="text" ?disabled=${!about?.logDir} @click=${this.#showLogs}>
          <md-icon slot="icon" class="acp-about-dialog__icon">${unsafeSVG(folderOpenIcon)}</md-icon>
          Show log files
        </md-button>
        <md-button class="acp-about-dialog__action acp-about-dialog__action_close" variant="filled" autofocus @click=${this.#close}>Close</md-button>
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-about-dialog', AcpAboutDialog);
