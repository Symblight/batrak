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
 * @summary About Brama: the app's version, what it runs on and its log files.
 * @fires acp-reveal-path `{ path }` Show log files.
 */
export class AcpAboutDialog extends LitElement {
  static properties = {
    about: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {AboutInfo | null} `null` until read. */
    this.about = null;
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

  render() {
    const about = this.about;
    return html`<md-dialog class="acp-about-dialog__dialog" wide>
      <div slot="headline" class="acp-about-dialog__headline">
        <img class="acp-about-dialog__logo" src="/favicon.svg" alt="" />
        <span class="acp-about-dialog__title">Brama</span>
        <span class="acp-about-dialog__subtitle">${about ? `Version ${about.version}` : nothing}</span>
      </div>
      ${about
        ? html`<dl class="acp-about-dialog__rows">
            ${app.aboutRows(about).map(
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
