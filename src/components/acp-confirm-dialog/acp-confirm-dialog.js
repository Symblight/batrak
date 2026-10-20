import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import styles from './acp-confirm-dialog.css?inline';

/** @typedef {import('../../models/types.js').ConfirmOptions} ConfirmOptions */

/**
 * @tag acp-confirm-dialog
 * @summary Modal yes/no question; `confirm()` resolves `true` only when the confirm action is chosen.
 */
export class AcpConfirmDialog extends LitElement {
  static properties = {
    options: { state: true },
  };

  static styles = styles;

  /** @type {((confirmed: boolean) => void) | null} */
  #resolve = null;

  constructor() {
    super();
    /** @type {ConfirmOptions | null} */
    this.options = null;
  }

  get #dialog() {
    return /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog'));
  }

  /**
   * Asks; a question still open is answered `false` first.
   * @param {ConfirmOptions} options
   * @returns {Promise<boolean>}
   */
  async confirm(options) {
    this.#settle(false);
    this.options = options;
    await this.updateComplete;
    const answer = new Promise((resolve) => (this.#resolve = resolve));
    await this.#dialog.show();
    return /** @type {Promise<boolean>} */ (answer);
  }

  /** Answers the open question `false`, as when its asker no longer needs the answer. */
  close() {
    this.#settle(false);
  }

  /** @param {boolean} confirmed */
  #settle(confirmed) {
    const resolve = this.#resolve;
    if (!resolve) return;
    this.#resolve = null;
    this.#dialog.close();
    resolve(confirmed);
  }

  #onCancel = () => this.#settle(false);

  #onConfirm = () => this.#settle(true);

  // The native <dialog> closes itself on Escape, and its `close` event doesn't leave md-dialog's shadow root.
  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key === 'Escape') this.#settle(false);
  };

  render() {
    const options = this.options;
    return html`<md-dialog
      class=${classMap({
        'acp-confirm-dialog__dialog': true,
        'acp-confirm-dialog__dialog_top': options?.placement === 'top',
      })}
      role="alertdialog"
      @keydown=${this.#onKeydown}
    >
      <h2 slot="headline" class="acp-confirm-dialog__headline">${options?.headline ?? nothing}</h2>
      <div class="acp-confirm-dialog__content">
        <p class="acp-confirm-dialog__message">${options?.message ?? nothing}</p>
        ${options?.detail ? html`<p class="acp-confirm-dialog__detail">${options.detail}</p>` : nothing}
      </div>
      <div slot="footer" class="acp-confirm-dialog__footer">
        <md-button class="acp-confirm-dialog__action" variant="text" autofocus @click=${this.#onCancel}
          >${options?.cancelLabel ?? 'Cancel'}</md-button
        >
        <md-button
          class=${classMap({
            'acp-confirm-dialog__action': true,
            'acp-confirm-dialog__action_destructive': !!options?.destructive,
          })}
          variant="filled"
          @click=${this.#onConfirm}
          >${options?.confirmLabel ?? 'OK'}</md-button
        >
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-confirm-dialog', AcpConfirmDialog);
