import { search } from '../../hooks/search/search.js';
import { LitElement, html } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/chips';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/text-field';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import maskIcon from '@material-design-icons/svg/outlined/filter_alt.svg?raw';
import styles from './search-filters.css?inline';

/** @typedef {import('../../models/types/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {'folder' | 'mask'} Filter */

/** File masks offered in the mask menu. */
const MASK_PRESETS = ['*.{js,ts}', '*.css', '*.md', '!*.test.js', '!pnpm-lock.yaml'];

/**
 * @tag acp-search-filters
 * @summary The folder and file-mask filters of a search: a chip each, opening a menu to pick or type one.
 * @fires acp-search-filter-change `{ which, value }` A filter was set or, with `''`, cleared.
 * @fires acp-search-filter-folders `{ query }` Folders to list in the folder menu (answered through `folders` and `foldersQuery`).
 * @fires acp-search-filter-leave A pick, a removal or a menu closing with focus in it: focus belongs to the query again.
 */
export class AcpSearchFilters extends LitElement {
  static properties = {
    folder: { type: String },
    mask: { type: String },
    folders: { attribute: false },
    foldersQuery: { attribute: false },
  };

  static styles = styles;

  /** @type {string | null} The last `acp-search-filter-folders` query: `folders` is current when `foldersQuery` matches it. */
  #foldersAsked = null;

  constructor() {
    super();
    /** @type {string} Root-relative, `''` for the whole project. */
    this.folder = '';
    /** @type {string} */
    this.mask = '';
    /** @type {readonly QuickOpenItem[]} The folder menu's folders, for the last `acp-search-filter-folders`. */
    this.folders = [];
    /** @type {string | null} The query `folders` answers. */
    this.foldersQuery = null;
  }

  /** Closes both menus. */
  closeMenus() {
    for (const which of /** @type {Filter[]} */ (['folder', 'mask'])) this.#menu(which)?.close();
  }

  /**
   * Closes the open menu, if any.
   * @returns {boolean} One was open.
   */
  closeOpenMenu() {
    const menu = /** @type {Filter[]} */ (['folder', 'mask']).map((which) => this.#menu(which)).find((m) => m?.open);
    menu?.close();
    return Boolean(menu);
  }

  /**
   * @param {string} type
   * @param {object} [detail]
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Filter} which */
  #menu(which) {
    return /** @type {HTMLElementTagNameMap['md-menu'] | null} */ (
      this.renderRoot?.querySelector(`.acp-search-filters__menu[data-filter="${which}"]`) ?? null
    );
  }

  /** @param {Filter} which */
  #menuField(which) {
    return /** @type {HTMLElementTagNameMap['md-text-field'] | null} */ (this.#menu(which)?.querySelector('.acp-search-filters__menu-field') ?? null);
  }

  /**
   * @param {Filter} which
   * @param {string} value
   */
  #setFilter(which, value) {
    this.#emit('acp-search-filter-change', { which, value });
  }

  /**
   * The remove button goes with its chip: focus moves to the query instead of the page.
   * @param {Filter} which
   */
  #removeFilter(which) {
    this.#menu(which)?.close();
    this.#setFilter(which, '');
    this.#emit('acp-search-filter-leave');
  }

  /** @param {Filter} which */
  async #toggleMenu(which) {
    // The chip flipped its own `selected`; the render sets it back.
    this.requestUpdate();
    const menu = this.#menu(which);
    const chip = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(`.acp-search-filters__chip[data-filter="${which}"]`));
    if (!menu || !chip) return;
    if (menu.open) {
      menu.close();
      return;
    }
    const field = this.#menuField(which);
    if (field) field.value = which === 'mask' ? this.mask : '';
    if (which === 'folder') this.#askFolders('');
    menu.anchorElement = chip;
    await menu.show();
  }

  /** @param {Filter} which */
  #onMenuOpened(which) {
    this.#menuField(which)?.focus();
  }

  /**
   * The menu would give focus back to its `for` anchor, which it doesn't have: without this, focus
   * drops to the page and the dialog's keys stop working.
   * @param {Filter} which
   */
  #onMenuClosing(which) {
    if (this.#menu(which)?.matches(':focus-within')) this.#emit('acp-search-filter-leave');
  }

  /**
   * @param {Filter} which
   * @param {Event} e
   */
  #onMenuSelect(which, e) {
    // `select` bubbles, composed: it's the menu's, not this element's. The menu re-fires its
    // item's `select` from itself; act on that one only.
    e.stopPropagation();
    if (e.target !== e.currentTarget) return;
    this.#setFilter(which, /** @type {CustomEvent<{ value: string }>} */ (e).detail.value);
    this.#emit('acp-search-filter-leave');
  }

  /** @param {string} query */
  #askFolders(query) {
    this.#foldersAsked = query;
    this.#emit('acp-search-filter-folders', { query });
  }

  /** @param {Event} e */
  #onFolderFieldInput(e) {
    this.#askFolders(/** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value);
  }

  /**
   * Keeps typing in the field: the menu would take printable keys, Home and End for typeahead.
   * Enter sets the mask, or picks the first folder.
   * @param {Filter} which
   * @param {KeyboardEvent} e
   */
  #onMenuFieldKeydown(which, e) {
    if (e.isComposing) {
      e.stopPropagation();
      return;
    }
    // Esc and the arrows go on to the menu; Alt+C / W / R to the dialog.
    if (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || search.optionForKey(e)) return;
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = this.#menuField(which)?.value.trim() ?? '';
    // A folder only from a list that answers what the field says now.
    const current = this.foldersQuery !== null && this.foldersQuery === this.#foldersAsked;
    const value = which === 'mask' ? text : text && current ? this.folders[0]?.path : undefined;
    if (value === undefined) return;
    this.#setFilter(which, value);
    this.#menu(which)?.close();
    this.#emit('acp-search-filter-leave');
  }

  /**
   * A filter's chip: unset, a filter chip naming it; set, an input chip with its value and a remove button.
   * @param {Filter} which
   * @param {string} icon
   * @param {string} label
   * @param {string} value
   */
  #renderChip(which, icon, label, value) {
    const leading = html`<md-icon slot="leading-icon" class="acp-search-filters__chip-icon">${unsafeSVG(icon)}</md-icon>`;
    if (!value) {
      return html`<md-filter-chip
        class="acp-search-filters__chip"
        data-filter=${which}
        aria-haspopup="menu"
        .selected=${live(false)}
        @click=${() => this.#toggleMenu(which)}
        >${leading}${label}</md-filter-chip
      >`;
    }
    return html`<md-input-chip
      class="acp-search-filters__chip acp-search-filters__chip_set"
      data-filter=${which}
      aria-haspopup="menu"
      removable
      .selected=${live(false)}
      @click=${() => this.#toggleMenu(which)}
      @remove=${() => this.#removeFilter(which)}
      >${leading}<span class="acp-search-filters__chip-value">${value}</span></md-input-chip
    >`;
  }

  #renderFolderMenu() {
    return html`<md-menu
      class="acp-search-filters__menu"
      data-filter="folder"
      placement="bottom-start"
      @opened=${() => this.#onMenuOpened('folder')}
      @closing=${() => this.#onMenuClosing('folder')}
      @select=${(/** @type {Event} */ e) => this.#onMenuSelect('folder', e)}
    >
      <md-text-field
        class="acp-search-filters__menu-field"
        variant="outlined"
        placeholder="Filter folders"
        aria-label="Filter folders"
        spellcheck="false"
        @input=${this.#onFolderFieldInput}
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onMenuFieldKeydown('folder', e)}
      ></md-text-field>
      ${this.folders.length === 0
        ? html`<div class="acp-search-filters__menu-empty">No matching folders</div>`
        : this.folders.map(
            (folder) => html`<md-menu-item value=${folder.path} ?selected=${folder.path === this.folder}
              ><span class="acp-search-filters__menu-path">${folder.path}</span></md-menu-item
            >`,
          )}
    </md-menu>`;
  }

  #renderMaskMenu() {
    return html`<md-menu
      class="acp-search-filters__menu"
      data-filter="mask"
      placement="bottom-start"
      @opened=${() => this.#onMenuOpened('mask')}
      @closing=${() => this.#onMenuClosing('mask')}
      @select=${(/** @type {Event} */ e) => this.#onMenuSelect('mask', e)}
    >
      <md-text-field
        class="acp-search-filters__menu-field"
        variant="outlined"
        placeholder="*.ts, !*.test.ts"
        aria-label="File mask"
        spellcheck="false"
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onMenuFieldKeydown('mask', e)}
      ></md-text-field>
      ${MASK_PRESETS.map(
        (preset) => html`<md-menu-item value=${preset} ?selected=${preset === this.mask}
          ><span class="acp-search-filters__menu-path">${preset}</span></md-menu-item
        >`,
      )}
    </md-menu>`;
  }

  render() {
    return html`${this.#renderChip('folder', folderIcon, 'Folder', this.folder)} ${this.#renderChip('mask', maskIcon, 'File mask', this.mask)}
    ${this.#renderFolderMenu()} ${this.#renderMaskMenu()}`;
  }
}

customElements.define('acp-search-filters', AcpSearchFilters);
