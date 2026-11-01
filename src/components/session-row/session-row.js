import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import pinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import '../agent-icon/agent-icon.js';
import '../datetime/datetime.js';
import '../session-status/session-status.js';
import styles from './session-row.css?inline';

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

/**
 * @tag acp-session-row
 * @summary A session in the list: its agent, title (F2 or a double-click renames it in place), worktree branch, age and status, swapped for a menu button while hovered or focused.
 * @fires acp-session-select `{ sessionId }`
 * @fires acp-session-rename `{ sessionId, title }` A new title, trimmed, not empty and not the current one.
 * @fires acp-session-row-menu `{ session, x, y }` or `{ session, anchor }` Its menu is wanted: at the pointer or under the focused row (`x`, `y`), or under its menu button (`anchor`).
 */
export class AcpSessionRow extends LitElement {
  static properties = {
    session: { attribute: false },
    selected: { type: Boolean },
    pinned: { type: Boolean },
    unread: { type: Boolean },
    waiting: { type: Boolean },
    menuOpen: { type: Boolean, attribute: 'menu-open' },
    tabStop: { type: Boolean },
    now: { attribute: false },
    renaming: { state: true },
    hovered: { state: true },
    focused: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Session | null} */
    this.session = null;
    /** @type {boolean} */
    this.selected = false;
    /** @type {boolean} */
    this.pinned = false;
    /** @type {boolean} Output it has not shown yet. */
    this.unread = false;
    /** @type {boolean} A permission request of it waits for the user. */
    this.waiting = false;
    /** @type {boolean} Its menu is open: the menu button stays. */
    this.menuOpen = false;
    /** @type {boolean} The tree's Tab stop (`TreeNavigationController` moves it). */
    this.tabStop = true;
    /** @type {number} The time, ms: a session active in another app shows so until its time is up. */
    this.now = Date.now();
    /** @type {boolean} Its title is being edited in the row. */
    this.renaming = false;
    /** @type {boolean} */
    this.hovered = false;
    /** @type {boolean} */
    this.focused = false;
  }

  /** Focuses the row. */
  focusRow() {
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-session-row__row'))?.focus();
  }

  /** Swaps the title for a text field, focused with its text selected. */
  async startRename() {
    this.renaming = true;
    await this.updateComplete;
    const field = this.renderRoot.querySelector('md-text-field');
    if (!field) return;
    await field.updateComplete;
    field.focus();
    if (field.inputOrTextArea instanceof HTMLInputElement) field.inputOrTextArea.select();
  }

  /**
   * @param {string} type
   * @param {object | null} [detail]
   */
  #emit(type, detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * F2 renames, Enter/Space selects, ContextMenu or Shift+F10 asks for the menu.
   * @param {KeyboardEvent} e
   */
  #onKeydown(e) {
    const session = this.session;
    if (!session || e.target !== e.currentTarget) return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      this.#emit('acp-session-row-menu', { session, x: rect.left + 24, y: rect.bottom });
    } else if (e.key === 'F2') this.startRename();
    else if (e.key === 'Enter' || e.key === ' ') this.#emit('acp-session-select', { sessionId: session.id });
    else return;
    e.preventDefault();
  }

  /** @param {MouseEvent} e */
  #onContextMenu(e) {
    if (!this.session) return;
    e.preventDefault();
    e.stopPropagation();
    this.#emit('acp-session-row-menu', { session: this.session, x: e.clientX, y: e.clientY });
  }

  /** @param {FocusEvent} e */
  #onFocusOut(e) {
    const row = /** @type {HTMLElement} */ (e.currentTarget);
    if (this.focused && !(e.relatedTarget instanceof Node && row.contains(e.relatedTarget))) this.focused = false;
  }

  /**
   * Enter or leaving the field saves the title, Escape keeps the old one; so does an empty field.
   * @param {HTMLElementTagNameMap['md-text-field']} field
   * @param {boolean} save
   */
  async #endRename(field, save) {
    const session = this.session;
    if (!session || !this.renaming) return;
    this.renaming = false;
    const title = field.value.trim();
    if (save && title !== '' && title !== session.title) this.#emit('acp-session-rename', { sessionId: session.id, title });
    await this.updateComplete;
    this.focusRow();
  }

  /** @param {KeyboardEvent} e */
  #onRenameKeydown(e) {
    e.stopPropagation();
    const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget);
    if (e.key === 'Enter') this.#endRename(field, true);
    else if (e.key === 'Escape') this.#endRename(field, false);
    else return;
    e.preventDefault();
  }

  render() {
    const session = this.session;
    if (!session) return nothing;
    const name = session.agentName ?? session.agentId;
    const showMore = this.hovered || this.focused || this.menuOpen;
    return html`<div
        class="acp-session-row__row ${this.selected ? 'acp-session-row__row_selected' : ''}"
        role="treeitem"
        tabindex=${this.tabStop ? 0 : -1}
        aria-level="2"
        aria-selected=${this.selected ? 'true' : 'false'}
        @click=${() => this.#emit('acp-session-select', { sessionId: session.id })}
        @dblclick=${() => this.startRename()}
        @keydown=${this.#onKeydown}
        @contextmenu=${this.#onContextMenu}
        @pointerenter=${() => (this.hovered = true)}
        @pointerleave=${() => (this.hovered = false)}
        @focusin=${() => (this.focused = true)}
        @focusout=${this.#onFocusOut}
      >
        ${this.pinned
          ? html`<md-icon id="acp-session-row-pin" class="acp-session-row__pin" aria-label="Pinned">${unsafeSVG(pinIcon)}</md-icon>`
          : nothing}
        <acp-agent-icon
          id="acp-session-row-agent"
          class="acp-session-row__agent"
          .agent=${{ id: session.agentId, name: session.agentName }}
          aria-label=${name}
        ></acp-agent-icon>
        ${this.renaming
          ? html`<md-text-field
              class="acp-session-row__rename"
              variant="outlined"
              aria-label="Session title"
              spellcheck="false"
              .value=${session.title}
              @click=${(/** @type {Event} */ e) => e.stopPropagation()}
              @dblclick=${(/** @type {Event} */ e) => e.stopPropagation()}
              @keydown=${this.#onRenameKeydown}
              @focusout=${(/** @type {FocusEvent} */ e) => this.#endRename(/** @type {HTMLElementTagNameMap['md-text-field']} */ (e.currentTarget), true)}
            ></md-text-field>`
          : html`<span class="acp-session-row__title ${this.unread ? 'acp-session-row__title_unread' : ''}">${session.title}</span>`}
        ${session.branch
          ? html`<md-icon id="acp-session-row-branch" class="acp-session-row__branch" aria-label="Worktree">${unsafeSVG(branchIcon)}</md-icon>`
          : nothing}
        <acp-datetime class="acp-session-row__age" .value=${session.lastActivityAt} .now=${this.now} format="compact"></acp-datetime>
        ${showMore
          ? html`<md-icon-button
              id="acp-session-row-more"
              class="acp-session-row__more"
              aria-label=${`Session menu: ${session.title}`}
              @click=${(/** @type {Event} */ e) => {
                e.stopPropagation();
                this.#emit('acp-session-row-menu', { session, anchor: e.currentTarget });
              }}
            >
              <md-icon class="acp-session-row__more-icon">${unsafeSVG(moreIcon)}</md-icon>
            </md-icon-button>`
          : html`<!-- An idle terminal session looks like any other in the list (quiet); the header still says it. -->
              <acp-session-status
                class="acp-session-row__status"
                .session=${session}
                .permissionPending=${this.waiting}
                .now=${this.now}
                quiet
              ></acp-session-status>`}
      </div>
      <md-tooltip for="acp-session-row-agent" show-delay="800">${name}</md-tooltip>
      ${this.pinned ? html`<md-tooltip for="acp-session-row-pin" show-delay="800">Pinned</md-tooltip>` : nothing}
      ${session.branch ? html`<md-tooltip for="acp-session-row-branch" show-delay="800">Worktree on ${session.branch}</md-tooltip>` : nothing}
      ${showMore ? html`<md-tooltip for="acp-session-row-more" show-delay="800">Session menu</md-tooltip>` : nothing}`;
  }
}

customElements.define('acp-session-row', AcpSessionRow);
