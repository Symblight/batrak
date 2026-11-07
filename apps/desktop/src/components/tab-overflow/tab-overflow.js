import { LitElement, html, nothing } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import pushPinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import '../file-icon/file-icon.js';
import styles from './tab-overflow.css?inline';

/**
 * A tab out of the strip's view, as the list shows it. `file` is set (and `icon` empty) when the
 * icon is the file's own.
 * @typedef {Object} TabOverflowItem
 * @property {string} id
 * @property {string} title
 * @property {string} icon An SVG.
 * @property {string | null} file
 * @property {string} tooltip
 * @property {boolean} pinned
 * @property {boolean} unsaved
 * @property {boolean} deleted Deleted on disk, still open.
 */

/**
 * @tag acp-tab-overflow
 * @summary Show Hidden Tabs: a button, while the tabs overflow their strip, opening the list of those out of view; a row activates its tab, its × closes it (or unpins it), Delete closes the focused row.
 * @fires acp-tab-activate `{ id }`
 * @fires acp-tab-overflow-close `{ id }` Close the tab, or unpin it when pinned: the list stays open.
 * @fires acp-tab-overflow-closed The list closed.
 */
export class AcpTabOverflow extends LitElement {
  static properties = {
    items: { attribute: false },
    active: { attribute: false },
    visible: { type: Boolean },
  };

  static styles = styles;

  /** @type {{ id: string, index: number } | null} A row Delete closed: once it's gone, the row now at its index takes the focus. */
  #refocus = null;

  constructor() {
    super();
    /** @type {readonly TabOverflowItem[]} The tabs out of view, in strip order. */
    this.items = [];
    /** @type {string | null} The active tab's id. */
    this.active = null;
    /** @type {boolean} The tabs overflow: the button shows. */
    this.visible = false;
  }

  /** Whether the list is open. */
  get open() {
    return this.#menu?.open ?? false;
  }

  /** @returns {HTMLElementTagNameMap['md-menu'] | null} */
  get #menu() {
    return this.renderRoot?.querySelector('.acp-tab-overflow__menu') ?? null;
  }

  /** @param {import('lit').PropertyValues<this>} _changed */
  updated(_changed) {
    this.#update();
  }

  /** Closes the list once no row is left, and moves the focus off a row Delete closed. */
  #update() {
    const menu = this.#menu;
    if (!menu?.open) return;
    const rows = /** @type {HTMLElementTagNameMap['md-menu-item'][]} */ ([...menu.querySelectorAll('.acp-tab-overflow__item')]);
    if (!rows.length) {
      menu.close();
      return;
    }
    const refocus = this.#refocus;
    if (refocus === null || rows.some((r) => r.getAttribute('value') === refocus.id)) return;
    this.#refocus = null;
    const row = rows[Math.min(refocus.index, rows.length - 1)];
    rows.forEach((r) => r.setTabIndex(r === row ? 0 : -1));
    row.focusInteractive();
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** The button opens the list under itself, the active row (or the first) focused, and closes it when open. */
  #onClick = async (/** @type {Event} */ e) => {
    const menu = this.#menu;
    const button = /** @type {HTMLElement} */ (e.currentTarget);
    if (!menu) return;
    if (menu.open) {
      await menu.close();
      return;
    }
    menu.anchorElement = button;
    await menu.show();
    menu.focusSelectedItem();
  };

  /** ArrowDown on the button opens the list, like Enter and Space. */
  #onButtonKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'ArrowDown' || this.#menu?.open) return;
    e.preventDefault();
    /** @type {HTMLElement} */ (e.currentTarget).click();
  };

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return; // the item's own `select`; the menu dispatches it again
    this.#emit('acp-tab-activate', { id: /** @type {CustomEvent<{ value: string }>} */ (e).detail.value });
  };

  /** Delete or Backspace on a row closes its tab, the list staying open. */
  #onMenuKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const row = e
      .composedPath()
      .find(/** @returns {n is HTMLElement} */ (n) => n instanceof HTMLElement && n.classList.contains('acp-tab-overflow__item'));
    const id = row?.getAttribute('value');
    if (!row || !id) return;
    e.preventDefault();
    e.stopPropagation();
    this.#refocus = { id, index: [...(row.parentElement?.children ?? [])].indexOf(row) };
    this.#emit('acp-tab-overflow-close', { id });
  };

  #onOpening = () => {
    const menu = this.#menu;
    if (menu) ContextMenuController.showOnly(menu);
    this.requestUpdate(); // the button's aria-expanded
  };

  #onClosed = () => {
    this.#refocus = null;
    this.requestUpdate();
    this.#emit('acp-tab-overflow-closed', null);
  };

  /**
   * A tab's icon: the file's own, or the SVG of a view tab.
   * @param {TabOverflowItem} item
   */
  #renderIcon({ icon, file }) {
    return file !== null
      ? html`<acp-file-icon slot="leading" name=${file}></acp-file-icon>`
      : html`<md-icon slot="leading">${unsafeSVG(icon)}</md-icon>`;
  }

  /** @param {TabOverflowItem} item */
  #renderItem(item) {
    const { title, tooltip, pinned } = item;
    // Tooltips sit in the trailing slot: the default slot's text is the item's typeahead label.
    const id = `acp-tab-overflow-${item.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    return html`<md-menu-item id=${id} class="acp-tab-overflow__item" value=${item.id} ?selected=${item.id === this.active}>
      ${this.#renderIcon(item)}
      <span class="acp-tab-overflow__title ${item.deleted ? 'acp-tab-overflow__title_deleted' : ''}">${title}</span
      >${item.unsaved ? html`<span id="${id}-unsaved" class="acp-tab-overflow__unsaved">●</span>` : nothing}
      <span
        id="${id}-close"
        slot="trailing"
        class="acp-tab-overflow__close"
        role="button"
        aria-label="${pinned ? 'Unpin' : 'Close'} ${title}"
        @click=${(/** @type {Event} */ e) => {
          e.stopPropagation(); // don't let the row activate its tab
          this.#emit('acp-tab-overflow-close', { id: item.id });
        }}
        ><md-icon class="acp-tab-overflow__close-icon">${unsafeSVG(pinned ? pushPinIcon : closeIcon)}</md-icon></span
      >
      <md-tooltip slot="trailing" class="acp-tab-overflow__tooltip" for=${id} placement="right" show-delay="800">${tooltip}</md-tooltip>
      ${item.unsaved
        ? html`<md-tooltip slot="trailing" for="${id}-unsaved" placement="top" show-delay="800">Unsaved changes</md-tooltip>`
        : nothing}
      <md-tooltip slot="trailing" for="${id}-close" placement="top" show-delay="800">${pinned ? 'Unpin' : 'Close'}</md-tooltip>
    </md-menu-item>`;
  }

  render() {
    return html`${this.visible
        ? html`<md-icon-button
              id="overflow"
              class="acp-tab-overflow__button"
              aria-label="Show Hidden Tabs"
              aria-haspopup="menu"
              aria-expanded=${this.open ? 'true' : 'false'}
              @click=${this.#onClick}
              @keydown=${this.#onButtonKeydown}
              ><md-icon class="acp-tab-overflow__icon">${unsafeSVG(expandMoreIcon)}</md-icon></md-icon-button
            >
            <md-tooltip class="acp-tab-overflow__tooltip" for="overflow" placement="bottom" show-delay="800">Show Hidden Tabs</md-tooltip>`
        : nothing}
      <md-menu
        class="acp-tab-overflow__menu"
        aria-label="Hidden Tabs"
        placement="bottom-end"
        focus-on-open="selected"
        @opening=${this.#onOpening}
        @closed=${this.#onClosed}
        @select=${this.#onSelect}
        @keydown=${this.#onMenuKeydown}
      >
        ${repeat(this.items, (item) => item.id, (item) => this.#renderItem(item))}
      </md-menu>`;
  }
}

customElements.define('acp-tab-overflow', AcpTabOverflow);
