import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import archiveIcon from '@material-design-icons/svg/outlined/archive.svg?raw';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import downloadIcon from '@material-design-icons/svg/outlined/download.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import newSessionIcon from '@material-design-icons/svg/outlined/edit_note.svg?raw';
import openInIcon from '@material-design-icons/svg/outlined/open_in_new.svg?raw';
import permissionIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { INDICATOR_LABELS } from '../../models/sessions.js';
import styles from './acp-session-header.css?inline';

/** @typedef {import('../../models/types.js').SessionIndicator} SessionIndicator */

const STATUS_ICONS = { permission: permissionIcon, error: errorIcon };

/**
 * @tag acp-session-header
 * @summary The chat column's header: the active session's status and title, which opens its menu (rename in place, reveal, delete), and a new-session button.
 * @fires acp-session-rename `{ title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-reveal `null`
 * @fires acp-session-delete `null`
 * @fires acp-session-new `null`
 */
export class AcpSessionHeader extends LitElement {
  static properties = {
    sessionTitle: { attribute: 'session-title' },
    draft: { type: Boolean },
    indicator: {},
    renaming: { state: true },
    menuOpen: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.sessionTitle = '';
    /** @type {boolean} A new session before its first message: no menu yet. */
    this.draft = false;
    /** @type {SessionIndicator | null} */
    this.indicator = null;
    /** @type {boolean} The title is an editable field. */
    this.renaming = false;
    /** @type {boolean} */
    this.menuOpen = false;
  }

  /**
   * @param {string} type
   * @param {object | null} [detail]
   */
  #emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @returns {HTMLElement | null} */
  get #titleButton() {
    return this.renderRoot.querySelector('.acp-session-header__title-button');
  }

  async #startRename() {
    this.renaming = true;
    await this.updateComplete;
    const field = this.renderRoot.querySelector('md-text-field');
    if (!field) return;
    await field.updateComplete;
    field.focus();
    if (field.inputOrTextArea instanceof HTMLInputElement) field.inputOrTextArea.select();
  }

  /**
   * Enter or leaving the field saves the title, Escape keeps the old one; so does an empty field.
   * @param {HTMLElementTagNameMap['md-text-field']} field
   * @param {boolean} save
   */
  async #endRename(field, save) {
    if (!this.renaming) return;
    this.renaming = false;
    const title = field.value.trim();
    if (save && title !== '' && title !== this.sessionTitle) this.#emit('acp-session-rename', { title });
    await this.updateComplete;
    this.#titleButton?.focus();
  }

  /** @param {KeyboardEvent} e */
  #onRenameKeydown = (e) => {
    const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget);
    if (e.key === 'Enter') this.#endRename(field, true);
    else if (e.key === 'Escape') this.#endRename(field, false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** @param {KeyboardEvent} e */
  #onTitleKeydown = (e) => {
    if (e.key !== 'F2') return;
    e.preventDefault();
    this.#startRename();
  };

  #onSelect = (/** @type {Event} */ e) => {
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (value === 'rename') this.#startRename();
    else if (value === 'reveal') this.#emit('acp-session-reveal');
    else if (value === 'delete') this.#emit('acp-session-delete');
  };

  #renderStatus() {
    const indicator = this.indicator;
    if (indicator === null) return nothing;
    const label = INDICATOR_LABELS[indicator];
    return html`<span
      class="acp-session-header__status acp-session-header__status_${indicator}"
      role="img"
      aria-label=${label}
      title=${label}
    >
      ${indicator === 'running'
        ? html`<md-progress-circular class="acp-session-header__spinner"></md-progress-circular>`
        : html`<md-icon class="acp-session-header__status-icon">${unsafeSVG(STATUS_ICONS[indicator])}</md-icon>`}
    </span>`;
  }

  #renderTitle() {
    if (this.draft) return html`<span class="acp-session-header__title acp-session-header__title_draft">New session</span>`;
    if (this.renaming)
      return html`<md-text-field
          class="acp-session-header__rename"
          variant="outlined"
          aria-label="Session title"
          spellcheck="false"
          .value=${this.sessionTitle}
          @keydown=${this.#onRenameKeydown}
          @focusout=${(/** @type {FocusEvent} */ e) =>
            this.#endRename(/** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget), true)}
        ></md-text-field>
        <span class="acp-session-header__hint">Enter to save · Esc</span>`;
    return html`<md-button
        id="acp-session-header-title"
        class=${classMap({ 'acp-session-header__title-button': true, 'acp-session-header__title-button_open': this.menuOpen })}
        variant="text"
        aria-label=${`Session menu: ${this.sessionTitle}`}
        @keydown=${this.#onTitleKeydown}
      >
        <span class="acp-session-header__label">
          <span class="acp-session-header__title">${this.sessionTitle}</span>
          <md-icon
            class=${classMap({ 'acp-session-header__chevron': true, 'acp-session-header__chevron_flipped': this.menuOpen })}
            >${unsafeSVG(expandMoreIcon)}</md-icon
          >
        </span>
      </md-button>
      <md-tooltip for="acp-session-header-title" show-delay="800" placement="bottom">${this.sessionTitle}</md-tooltip>`;
  }

  /**
   * Items whose backend isn't there yet are shown disabled. Gone while renaming: md-menu finds its
   * `for` anchor only when it connects, and the field replaces the button.
   */
  #renderMenu() {
    if (this.draft || this.renaming) return nothing;
    return html`<md-menu
      class="acp-session-header__menu"
      for="acp-session-header-title"
      placement="bottom-start"
      aria-label=${this.sessionTitle}
      @select=${this.#onSelect}
      @opening=${() => (this.menuOpen = true)}
      @closing=${() => (this.menuOpen = false)}
    >
      <md-item-group>
        <md-menu-item value="open-in" disabled>
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(openInIcon)}</md-icon>
          Open in
          <md-menu slot="submenu" class="acp-session-header__menu" aria-label="Open in">
            <md-menu-item value="open-terminal" disabled>
              <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(terminalIcon)}</md-icon>
              Terminal
            </md-menu-item>
          </md-menu>
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item value="rename">
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(editIcon)}</md-icon>
          Rename
          <span slot="trailing">F2</span>
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item value="reveal">
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(folderOpenIcon)}</md-icon>
          Reveal workspace in Files
        </md-menu-item>
        <md-menu-item value="export" disabled>
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(downloadIcon)}</md-icon>
          Export transcript (Markdown)
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item value="archive" disabled>
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(archiveIcon)}</md-icon>
          Archive
        </md-menu-item>
        <md-menu-item class="acp-session-header__menu-item acp-session-header__menu-item_danger" value="delete">
          <md-icon slot="leading" class="acp-session-header__menu-icon">${unsafeSVG(deleteIcon)}</md-icon>
          Delete…
        </md-menu-item>
      </md-item-group>
    </md-menu>`;
  }

  render() {
    return html`
      ${this.renaming ? nothing : this.#renderStatus()} ${this.#renderTitle()}
      <span class="acp-session-header__spacer"></span>
      ${this.renaming
        ? nothing
        : html`<md-icon-button
            class="acp-session-header__new"
            title="New session"
            aria-label="New session"
            @click=${() => this.#emit('acp-session-new')}
          >
            <md-icon class="acp-session-header__new-icon">${unsafeSVG(newSessionIcon)}</md-icon>
          </md-icon-button>`}
      ${this.#renderMenu()}
    `;
  }
}

customElements.define('acp-session-header', AcpSessionHeader);
