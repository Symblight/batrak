import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import newSessionIcon from '@material-design-icons/svg/outlined/edit_note.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import chatIcon from '@material-design-icons/svg/outlined/chat.svg?raw';
import '../session-menu/session-menu.js';
import '../session-status/session-status.js';
import styles from './session-header.css?inline';

/** @typedef {import('../../models/types/types.js').Session} Session */
/** @typedef {import('../../models/types/types.js').SessionView} SessionView */

/**
 * @tag acp-session-header
 * @summary The chat column's header: the active session's status and title, which opens its menu (rename in place, reveal, open in a terminal, delete), a Chat / Terminal switch and a new-session button.
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-reset-title `{ sessionId }`
 * @fires acp-session-reveal `{ sessionId }`
 * @fires acp-session-open-terminal `{ sessionId }` Open in → Terminal.
 * @fires acp-session-delete `{ sessionId }`
 * @fires acp-session-new `null`
 * @fires acp-session-view `{ sessionId, view }` Continue in the other view.
 */
export class AcpSessionHeader extends LitElement {
  static properties = {
    sessionId: { attribute: 'session-id' },
    sessionTitle: { attribute: 'session-title' },
    draft: { type: Boolean },
    provisional: { type: Boolean },
    resettable: { type: Boolean },
    session: { attribute: false },
    permissionPending: { type: Boolean, attribute: 'permission-pending' },
    now: { attribute: false },
    view: {},
    viewDisabled: { attribute: 'view-disabled' },
    renaming: { state: true },
    menuOpen: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} Named in every event about the session. */
    this.sessionId = '';
    /** @type {string} */
    this.sessionTitle = '';
    /** @type {boolean} A new session before its first message: no menu yet. */
    this.draft = false;
    /** @type {boolean} The first prompt's words, until the agent names the session. */
    this.provisional = false;
    /** @type {boolean} The user renamed a session the agent had named: its menu offers that back. */
    this.resettable = false;
    /** @type {Session | null} Its status icon is worked out from it; `null` for a draft. */
    this.session = null;
    /** @type {boolean} A permission request of the session waits for the user. */
    this.permissionPending = false;
    /** @type {number | null} ms; what the status judges "active in another app" against. */
    this.now = null;
    /** @type {SessionView} */
    this.view = 'chat';
    /** @type {string} Why the session can't switch views, the button's tooltip; `''` when it can. */
    this.viewDisabled = '';
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

  /** The agent's title just replaced the provisional one: it fades in. */
  #fadeIn = false;

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('sessionId')) this.#fadeIn = false;
    else if (changed.get('provisional') === true && !this.provisional) this.#fadeIn = true;
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
    if (save && title !== '' && title !== this.sessionTitle)
      this.#emit('acp-session-rename', { sessionId: this.sessionId, title });
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
    e.stopPropagation();
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    const sessionId = this.sessionId;
    if (value === 'rename') this.#startRename();
    else if (value === 'reset-title' || value === 'reveal' || value === 'open-terminal' || value === 'delete')
      this.#emit(`acp-session-${value}`, { sessionId });
  };

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
          <span
            class=${classMap({
              'acp-session-header__title': true,
              'acp-session-header__title_provisional': this.provisional,
              'acp-session-header__title_fade-in': this.#fadeIn,
            })}
            >${this.sessionTitle}</span
          >
          <md-icon
            class=${classMap({ 'acp-session-header__chevron': true, 'acp-session-header__chevron_flipped': this.menuOpen })}
            >${unsafeSVG(expandMoreIcon)}</md-icon
          >
        </span>
      </md-button>
      <md-tooltip for="acp-session-header-title" show-delay="800" placement="bottom">${this.sessionTitle}</md-tooltip>`;
  }

  /** Continue in terminal / in chat. */
  #renderViewToggle() {
    if (this.renaming) return nothing;
    const terminal = this.view === 'terminal';
    const label = terminal ? 'Continue in chat' : 'Continue in terminal';
    const disabled = this.viewDisabled !== '';
    return html`<md-icon-button
        id="acp-session-header-view"
        class="acp-session-header__view"
        aria-pressed=${terminal ? 'true' : 'false'}
        aria-label=${label}
      ?disabled=${disabled}
      @click=${() => {
        if (!disabled) this.#emit('acp-session-view', { sessionId: this.sessionId, view: terminal ? 'chat' : 'terminal' });
      }}
    >
      <md-icon class="acp-session-header__view-icon">${unsafeSVG(terminal ? chatIcon : terminalIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-session-header-view" show-delay="800" placement="bottom"
        >${disabled ? this.viewDisabled : label}</md-tooltip
      >`;
  }

  /** Gone while renaming: the field replaces the button it opens from. */
  #renderMenu() {
    if (this.draft || this.renaming) return nothing;
    return html`<acp-session-menu
      session-title=${this.sessionTitle}
      ?resettable=${this.resettable}
      @acp-session-menu-select=${this.#onSelect}
      @acp-session-menu-toggle=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.menuOpen = /** @type {CustomEvent<{ open: boolean }>} */ (e).detail.open;
      }}
    ></acp-session-menu>`;
  }

  /** The menu opens from the title button, which only exists once rendered. */
  updated() {
    const menu = this.renderRoot.querySelector('acp-session-menu');
    if (menu) menu.anchor = this.#titleButton;
  }

  render() {
    return html`
      ${this.renaming
        ? nothing
        : html`<acp-session-status
            class="acp-session-header__status"
            .session=${this.session}
            .permissionPending=${this.permissionPending}
            .now=${this.now}
          ></acp-session-status>`}
      ${this.#renderTitle()}
      <span class="acp-session-header__spacer"></span>
      ${this.#renderViewToggle()}
      ${this.renaming
        ? nothing
        : html`<md-icon-button
              id="acp-session-header-new"
              class="acp-session-header__new"
              aria-label="New session"
              @click=${() => this.#emit('acp-session-new')}
            >
              <md-icon class="acp-session-header__new-icon">${unsafeSVG(newSessionIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-session-header-new" show-delay="800" placement="bottom">New session</md-tooltip>`}
      ${this.#renderMenu()}
    `;
  }
}

customElements.define('acp-session-header', AcpSessionHeader);
