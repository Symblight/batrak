import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/chips';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import editNoteIcon from '@material-design-icons/svg/outlined/edit_note.svg?raw';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './commit-box.css?inline';

/** Past this, a summary line reads badly in `git log`. */
const SUMMARY_MAX = 72;
/** How many lines the message field shows at least, and at most before it scrolls. */
const MESSAGE_MIN_ROWS = 4;
const MESSAGE_MAX_ROWS = 6;

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
    const amend = /** @type {HTMLElementTagNameMap['md-filter-chip']} */ (e.target).selected;
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

  /** Why Commit can't run now, `null` when it can. */
  get #blocked() {
    if (this.message.trim() === '') return 'Write a commit message';
    return this.amend || this.included > 0 ? null : 'Select files to commit';
  }

  /** The library's textarea sizes itself only where `field-sizing` exists, from four lines up: these limits, on every webview. */
  async #fit() {
    const field = this.renderRoot.querySelector('md-text-field');
    await field?.updateComplete;
    const area = field?.inputOrTextArea;
    if (!(area instanceof HTMLTextAreaElement)) return;
    area.rows = MESSAGE_MIN_ROWS;
    Object.assign(area.style, { resize: 'none', minHeight: `${MESSAGE_MIN_ROWS}lh`, maxHeight: `${MESSAGE_MAX_ROWS}lh`, height: 'auto' });
    area.style.height = `${area.scrollHeight}px`;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  updated(changed) {
    if (changed.has('message')) void this.#fit();
  }

  /** @param {KeyboardEvent} e */
  #onMessageKeydown(e) {
    if (!shortcuts.matches('commit', e)) return;
    e.preventDefault();
    if (this.#blocked === null) this.#commit();
  }

  #renderSupport() {
    const length = this.message.split('\n', 1)[0].trim().length;
    return html`<div class="acp-commit-box__support">
      <span class="acp-commit-box__summary ${length > SUMMARY_MAX ? 'acp-commit-box__summary_over' : ''}">
        ${length === 0 ? 'First line is the summary' : `Summary ${length}/${SUMMARY_MAX}`}
      </span>
      <span class="acp-commit-box__shortcut"><kbd class="acp-commit-box__key">${shortcuts.hint('commit')}</kbd> to commit</span>
    </div>`;
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
    const blocked = this.#blocked;
    return html`<md-text-field
        class="acp-commit-box__message"
        variant="outlined"
        multiline
        label="Commit message"
        placeholder="Summary of the change"
        ?disabled=${this.committing}
        .value=${this.message}
        @input=${this.#onMessageInput}
        @keydown=${this.#onMessageKeydown}
      ></md-text-field>
      ${this.#renderSupport()}
      <div class="acp-commit-box__actions">
        <md-filter-chip class="acp-commit-box__amend" .selected=${this.amend} ?disabled=${this.committing} @change=${this.#onAmendChange}>
          <md-icon slot="selected-icon" class="acp-commit-box__icon">${unsafeSVG(checkIcon)}</md-icon>
          Amend
        </md-filter-chip>
        <span class="acp-commit-box__spacer"></span>
        <!-- The tooltip's anchor: a disabled button hears no hover. -->
        <span id="acp-commit-box-reason" class="acp-commit-box__reason">
          <md-button class="acp-commit-box__commit" variant="filled" ?disabled=${this.committing || blocked !== null} @click=${this.#commit}>
            ${this.committing
              ? html`<md-progress-circular slot="icon" class="acp-commit-box__spinner" aria-label="Committing"></md-progress-circular>`
              : html`<md-icon slot="icon" class="acp-commit-box__icon">${unsafeSVG(this.amend ? editNoteIcon : checkIcon)}</md-icon>`}
            ${label}
          </md-button>
        </span>
        ${blocked !== null && !this.committing ? html`<md-tooltip for="acp-commit-box-reason" show-delay="800">${blocked}</md-tooltip>` : nothing}
      </div>`;
  }
}

customElements.define('acp-commit-box', AcpCommitBox);
