import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import styles from './confirm-dialog.css?inline';

/** @typedef {import('../../hooks/app/types.js').ConfirmOptions} ConfirmOptions */
/** @typedef {import('../../hooks/app/types.js').ConfirmChoice} ConfirmChoice */

/** @type {Set<AcpConfirmDialog>} The questions open anywhere in the app. */
const openDialogs = new Set();
const settled = new EventTarget();

/**
 * @tag acp-confirm-dialog
 * @summary Modal question; `confirm()` resolves `true` only when the confirm action is chosen, `choose()` names the action (a third one with `extraLabel`).
 */
export class AcpConfirmDialog extends LitElement {
  static properties = {
    options: { state: true },
  };

  static styles = styles;

  /** @type {((choice: ConfirmChoice) => void) | null} */
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
    return (await this.choose(options)) === 'confirm';
  }

  /**
   * Asks; a question still open is answered `cancel` first.
   * @param {ConfirmOptions} options
   * @returns {Promise<ConfirmChoice>}
   */
  async choose(options) {
    this.#settle('cancel');
    openDialogs.add(this);
    this.options = options;
    await this.updateComplete;
    const answer = new Promise((resolve) => (this.#resolve = resolve));
    await this.#dialog.show();
    return /** @type {Promise<ConfirmChoice>} */ (answer);
  }

  /** Answers the open question `cancel`, as when its asker no longer needs the answer. */
  close() {
    this.#settle('cancel');
  }

  /**
   * Resolves once no other `<acp-confirm-dialog>` is open. For a question nobody just asked for: one
   * opening by itself over another would take the click meant for that one.
   */
  async othersClosed() {
    while ([...openDialogs].some((dialog) => dialog !== this)) {
      await new Promise((resolve) => settled.addEventListener('settled', resolve, { once: true }));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.close();
  }

  /** @param {ConfirmChoice} choice */
  #settle(choice) {
    openDialogs.delete(this);
    settled.dispatchEvent(new Event('settled'));
    const resolve = this.#resolve;
    if (!resolve) return;
    this.#resolve = null;
    this.#dialog.close();
    resolve(choice);
  }

  #onCancel = () => this.#settle('cancel');

  #onExtra = () => this.#settle('extra');

  #onConfirm = () => this.#settle('confirm');

  // The native <dialog> closes itself on Escape, and its `close` event doesn't leave md-dialog's shadow root.
  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key === 'Escape') this.#settle('cancel');
  };

  render() {
    const options = this.options;
    return html`<md-dialog
      class=${classMap({
        'acp-confirm-dialog__dialog': true,
        'acp-confirm-dialog__dialog_top': options?.placement === 'top',
      })}
      role="alertdialog"
      ?wide=${options?.placement === 'top'}
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
        ${options?.extraLabel
          ? html`<md-button class="acp-confirm-dialog__action" variant="text" @click=${this.#onExtra}
              >${options.extraLabel}</md-button
            >`
          : nothing}
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
