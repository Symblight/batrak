import { app } from '../../hooks/app/app.js';
import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import '@symblight/wc-material/icon';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import styles from './about-dialog.css?inline';

/** @typedef {import('../../hooks/settings/types.js').AboutInfo} AboutInfo */

/**
 * @tag acp-about-dialog
 * @summary About Batrak: the app's version, what it runs on, its log files and a check for updates.
 * @fires acp-reveal-path `{ path }` Show log files.
 * @fires acp-update-check `null` Check for updates.
 */
export class AcpAboutDialog extends LitElement {
  static properties = {
    about: { attribute: false },
    updateCheck: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {AboutInfo | null} `null` until read. */
    this.about = null;
    /** @type {import('../../hooks/app-update/types.js').UpdateCheck} */
    this.updateCheck = { checking: false, message: null };
  }

  /** Opens the dialog. */
  async show() {
    await /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog')).show();
  }

  #close = () => {
    /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog')).close();
  };

  #showLogs = () => {
    const logDir = this.about?.logDir;
    if (!logDir) return;
    this.dispatchEvent(new CustomEvent('acp-reveal-path', { detail: { path: logDir }, bubbles: true, composed: true }));
  };

  #checkForUpdates = () => {
    this.dispatchEvent(new CustomEvent('acp-update-check', { detail: null, bubbles: true, composed: true }));
  };

  #renderUpdates() {
    const { checking, message } = this.updateCheck;
    return html`<dt class="acp-about-dialog__label">Updates</dt>
      <dd class="acp-about-dialog__value acp-about-dialog__updates">
        <md-button class="acp-about-dialog__check" variant="text" ?disabled=${checking} @click=${this.#checkForUpdates}>Check for updates</md-button>
        <span role="status">${message ?? nothing}</span>
      </dd>`;
  }

  render() {
    const about = this.about;
    return html`<md-dialog class="acp-about-dialog__dialog" wide>
      <div slot="headline" class="acp-about-dialog__headline">
        <img class="acp-about-dialog__logo" src="/favicon.svg" alt="" />
        <span class="acp-about-dialog__title">Batrak</span>
        <span class="acp-about-dialog__subtitle">${about ? `Version ${about.version}` : nothing}</span>
      </div>
      ${about
        ? html`<dl class="acp-about-dialog__rows">
            ${app.aboutRows(about).map(
              ([label, value]) => html`<dt class="acp-about-dialog__label">${label}</dt>
                <dd class="acp-about-dialog__value">${value}</dd>`,
            )}
            ${about.updatesEnabled ? this.#renderUpdates() : nothing}
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
