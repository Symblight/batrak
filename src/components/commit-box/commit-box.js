import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/text-field';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import styles from './commit-box.css?inline';

/**
 * @tag acp-commit-box
 * @summary The commit form of the Changes pane: the message, Amend and a Commit button saying how many files it takes.
 * @fires acp-amend-start `null` Amend was turned on: `fillAmendMessage()` gets the last commit's message.
 * @fires acp-commit-submit `{ message, amend }` Commit was pressed (the message trimmed); answered by `finished()`.
 */
export class AcpCommitBox extends LitElement {
  static properties = {
    included: { type: Number },
    message: { state: true },
    amend: { state: true },
    committing: { state: true },
  };

  static styles = styles;

  /** The message typed before Amend replaced it, restored when Amend is turned off. */
  #draft = '';

  constructor() {
    super();
    /** @type {number} How many files the commit takes. */
    this.included = 0;
    /** @type {string} */
    this.message = '';
    /** @type {boolean} */
    this.amend = false;
    /** @type {boolean} A commit is running: the form is locked. */
    this.committing = false;
  }

  /**
   * The last commit's message, for Amend; ignored once Amend is off again.
   * @param {string | null} message `null` when there is none.
   */
  fillAmendMessage(message) {
    if (this.amend && message !== null) this.message = message;
  }

  /**
   * The commit `acp-commit-submit` asked for is done; a successful one clears the form.
   * @param {boolean} succeeded
   */
  finished(succeeded) {
    this.committing = false;
    if (!succeeded) return;
    this.message = '';
    this.#draft = '';
    this.amend = false;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onAmendChange(e) {
    const amend = /** @type {HTMLInputElement} */ (e.target).checked;
    this.amend = amend;
    if (!amend) {
      this.message = this.#draft;
      return;
    }
    this.#draft = this.message;
    this.#emit('acp-amend-start', null);
  }

  /** @param {Event} e */
  #onMessageInput(e) {
    this.message = /** @type {HTMLInputElement} */ (e.target).value;
  }

  #commit() {
    if (this.committing) return;
    this.committing = true;
    this.#emit('acp-commit-submit', { message: this.message.trim(), amend: this.amend });
  }

  render() {
    const included = this.included;
    const label = this.committing
      ? 'Committing…'
      : this.amend
        ? 'Amend commit'
        : included > 0
          ? `Commit ${included} ${included === 1 ? 'file' : 'files'}`
          : 'Commit';
    const canCommit = !this.committing && this.message.trim() !== '' && (included > 0 || this.amend);
    return html`<md-text-field
        class="acp-commit-box__message"
        variant="outlined"
        multiline
        label="Commit message"
        ?disabled=${this.committing}
        .value=${this.message}
        @input=${this.#onMessageInput}
      ></md-text-field>
      <div class="acp-commit-box__actions">
        <label class="acp-commit-box__amend">
          <md-checkbox .checked=${this.amend} ?disabled=${this.committing} @change=${this.#onAmendChange}></md-checkbox>
          Amend
        </label>
        <span class="acp-commit-box__spacer"></span>
        <md-button class="acp-commit-box__commit" variant="filled" ?disabled=${!canCommit} @click=${this.#commit}>
          <md-icon slot="icon" class="acp-commit-box__commit-icon">${unsafeSVG(checkIcon)}</md-icon>
          ${label}
        </md-button>
      </div>`;
  }
}

customElements.define('acp-commit-box', AcpCommitBox);
