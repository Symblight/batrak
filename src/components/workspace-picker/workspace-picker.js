import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import '../workspace-menu/workspace-menu.js';
import '../workspace-status/workspace-status.js';
import { STATUS_LABELS } from '../workspace-status/workspace-status.js';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import addTaskIcon from '@material-design-icons/svg/outlined/add_task.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import layersIcon from '@material-design-icons/svg/outlined/layers.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_horiz.svg?raw';
import styles from './workspace-picker.css?inline';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').WorkspaceStatus} WorkspaceStatus */

/** Main's id in `statuses`, `currentId`'s stand-in and `acp-workspace-select`. */
const MAIN = 'main';
/** The menu value of New workspace; a workspace's value is its id. */
const NEW = 'new-workspace';
/** From this many workspaces the menu gets a filter field. */
const FILTER_FROM = 8;
const BUTTON_ID = 'acp-workspace-picker-button';

/**
 * A field's native `select` (its text selected) bubbles like md-menu's pick: it mustn't reach the menu.
 * @param {Event} e
 */
const stopSelect = (e) => e.stopPropagation();

/**
 * @tag acp-workspace-picker
 * @summary The toolbar's workspace button and its menu, like the project menu's (Active, then Main, then New workspace): switch, rename in place (F2), each row's ⋯ menu (also Shift+F10), a filter from 8 workspaces; a badge while other workspaces wait. New workspace alone while only Main exists; a disabled icon without git.
 * @fires acp-workspace-select `{ id }` `main` for Main.
 * @fires acp-workspace-rename `{ id, name }`
 * @fires acp-workspace-new `null`
 */
export class AcpWorkspacePicker extends LitElement {
  static properties = {
    workspaces: { attribute: false },
    statuses: { attribute: false },
    currentId: { attribute: false },
    projectName: { attribute: false },
    projectPath: { attribute: false },
    enabled: { type: Boolean },
    open: { state: true },
    filter: { state: true },
    renamingId: { state: true },
    menuId: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly Workspace[]} The Active group, in its order (`orderWorkspaces()`). */
    this.workspaces = [];
    /** @type {Readonly<Record<string, WorkspaceStatus>>} By workspace id, Main's under `main`; idle when absent. */
    this.statuses = {};
    /** @type {string | null} The shown workspace; `null` for Main. */
    this.currentId = null;
    /** @type {string} */
    this.projectName = '';
    /** @type {string | null} Main's folder. */
    this.projectPath = null;
    /** @type {boolean} The project is a git repository with a commit. */
    this.enabled = false;
    /** @type {boolean} */
    this.open = false;
    /** @type {string} */
    this.filter = '';
    /** @type {string | null} The row being renamed. */
    this.renamingId = null;
    /** @type {string | null} Whose ⋯ menu shows. */
    this.menuId = null;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  get #menu() {
    return /** @type {HTMLElementTagNameMap['md-menu'] | null} */ (this.renderRoot.querySelector('.acp-workspace-picker__menu'));
  }

  get #current() {
    return this.currentId ?? MAIN;
  }

  /** @param {string} id */
  #status(id) {
    return this.statuses[id] ?? 'idle';
  }

  /** @param {string} id */
  #nameOf(id) {
    return id === MAIN ? 'Main' : (this.workspaces.find((w) => w.id === id)?.name ?? '');
  }

  get #filtering() {
    return this.workspaces.length >= FILTER_FROM;
  }

  /** The Active rows the filter keeps, and whether Main's is kept. */
  get #shown() {
    const query = this.#filtering ? this.filter.trim().toLowerCase() : '';
    const active = query ? this.workspaces.filter((w) => w.name.toLowerCase().includes(query)) : this.workspaces;
    return { active, main: !query || 'main'.includes(query) };
  }

  /** @param {string} id The row's. */
  #row(id) {
    return /** @type {HTMLElementTagNameMap['md-menu-item'] | null} */ (this.renderRoot.querySelector(`md-menu-item[value="${CSS.escape(id)}"]`));
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (value === NEW) this.#emit('acp-workspace-new', null);
    else if (value !== this.renamingId) this.#emit('acp-workspace-select', { id: value });
  };

  #onOpening = () => {
    this.open = true;
    this.filter = '';
    this.renamingId = null;
  };

  /** The focused row's id, if a row has the focus. */
  get #focusedId() {
    return this.renderRoot.querySelector('.acp-workspace-picker__row:focus-within')?.getAttribute('value') ?? null;
  }

  // F2 renames the focused row; Shift+F10 or the menu key opens its ⋯ menu. The other keys are md-menu's.
  #onMenuKeydown = (/** @type {KeyboardEvent} */ e) => {
    const id = this.#focusedId;
    if (id === null) return;
    if (e.key === 'F2' && id !== MAIN) {
      e.preventDefault();
      void this.#startRename(id);
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      void this.#openMenu(id, this.#row(id));
    }
  };

  /** @param {string} id */
  async #startRename(id) {
    this.renamingId = id;
    await this.updateComplete;
    /** @type {HTMLInputElement | null} */ (this.renderRoot.querySelector('.acp-workspace-picker__rename'))?.select();
  }

  // Every key stays in the field: the menu's own (arrows, typeahead, Escape) mustn't act meanwhile.
  #onRenameKeydown = (/** @type {KeyboardEvent} */ e) => {
    e.stopPropagation();
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    const id = this.renamingId;
    if (e.key === 'Enter') {
      const name = /** @type {HTMLInputElement} */ (e.currentTarget).value.trim();
      if (name === '') return;
      if (id !== null && name !== this.#nameOf(id)) this.#emit('acp-workspace-rename', { id, name });
    }
    // The row takes the focus before its field goes, so it never leaves the menu (which would close it).
    if (id !== null) this.#row(id)?.focusInteractive();
    this.renamingId = null;
  };

  #onRenameStart = (/** @type {Event} */ e) => {
    e.stopPropagation();
    void this.#startRename(/** @type {CustomEvent<{ id: string }>} */ (e).detail.id);
  };

  /**
   * @param {string} id
   * @param {HTMLElement | null} anchor
   */
  async #openMenu(id, anchor) {
    this.menuId = id;
    await this.updateComplete;
    const menu = this.renderRoot.querySelector('acp-workspace-menu');
    if (!menu) return;
    menu.anchor = anchor;
    await menu.updateComplete;
    menu.show();
  }

  #onFilter = (/** @type {Event} */ e) => {
    this.filter = /** @type {HTMLInputElement} */ (e.target).value;
  };

  // The field keeps its typing; ArrowDown goes to the first row, the menu's arrows from there.
  #onFilterKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') return;
    e.stopPropagation();
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    this.#menu?.focusFirstItem();
  };

  /**
   * @param {string} id
   * @param {string} name
   */
  #renderRow(id, name) {
    const status = this.#status(id);
    const current = id === this.#current;
    const renaming = id === this.renamingId;
    return html`<md-menu-item
      class="acp-workspace-picker__item acp-workspace-picker__row"
      value=${id}
      ?selected=${current}
      ?keep-open=${renaming}
      aria-label="${name}, ${STATUS_LABELS[status].toLowerCase()}"
    >
      ${current
        ? html`<md-icon slot="leading" class="acp-workspace-picker__check">${unsafeSVG(checkIcon)}</md-icon>`
        : html`<acp-workspace-status slot="leading" class="acp-workspace-picker__status" .status=${status}></acp-workspace-status>`}
      ${renaming
        ? html`<input
            class="acp-workspace-picker__rename"
            aria-label="Workspace name"
            .value=${name}
            @keydown=${this.#onRenameKeydown}
            @select=${stopSelect}
            @click=${(/** @type {Event} */ e) => e.stopPropagation()}
          />`
        : html`<span class="acp-workspace-picker__name">${name}</span>`}
      <md-icon-button
        slot="trailing"
        tabindex="-1"
        class="acp-workspace-picker__more"
        aria-label="More actions for ${name}"
        @click=${(/** @type {Event} */ e) => {
          e.stopPropagation();
          void this.#openMenu(id, /** @type {HTMLElement} */ (e.currentTarget));
        }}
      >
        <md-icon class="acp-workspace-picker__icon">${unsafeSVG(moreIcon)}</md-icon>
      </md-icon-button>
    </md-menu-item>`;
  }

  #renderMenu() {
    const { active, main } = this.#shown;
    const menuWorkspace = this.workspaces.find((w) => w.id === this.menuId) ?? null;
    return html`<md-menu
        class="acp-workspace-picker__menu"
        for=${BUTTON_ID}
        placement="bottom-start"
        focus-on-open="selected"
        aria-label="Workspaces · ${this.projectName}"
        @select=${this.#onSelect}
        @keydown=${this.#onMenuKeydown}
        @opening=${this.#onOpening}
        @closing=${() => (this.open = false)}
      >
        ${this.#filtering
          ? html`<input
              class="acp-workspace-picker__filter"
              aria-label="Filter workspaces"
              placeholder="Filter workspaces"
              .value=${this.filter}
              @input=${this.#onFilter}
              @keydown=${this.#onFilterKeydown}
              @select=${stopSelect}
            />`
          : nothing}
        ${active.length
          ? html`<md-item-group>
              <md-menu-group label="Active">${repeat(active, (w) => w.id, (w) => this.#renderRow(w.id, w.name))}</md-menu-group>
            </md-item-group>`
          : nothing}
        ${main ? html`<md-item-group><md-menu-group label="Main">${this.#renderRow(MAIN, 'Main')}</md-menu-group></md-item-group>` : nothing}
        <md-item-group>
          <md-menu-item class="acp-workspace-picker__item" value=${NEW}>
            <md-icon slot="leading" class="acp-workspace-picker__icon">${unsafeSVG(addIcon)}</md-icon>
            New workspace
          </md-menu-item>
        </md-item-group>
      </md-menu>
      <acp-workspace-menu
        .workspace=${menuWorkspace}
        .mainFolder=${this.projectPath}
        @acp-workspace-rename-start=${this.#onRenameStart}
      ></acp-workspace-menu>`;
  }

  render() {
    if (!this.enabled) {
      return html`<span id="acp-workspace-picker-disabled" class="acp-workspace-picker__disabled">
          <md-icon-button disabled aria-label="Workspaces need a git repository">
            <md-icon class="acp-workspace-picker__icon">${unsafeSVG(layersIcon)}</md-icon>
          </md-icon-button>
        </span>
        <md-tooltip for="acp-workspace-picker-disabled" show-delay="800" placement="bottom">Workspaces need a git repository</md-tooltip>`;
    }
    if (this.workspaces.length === 0) {
      return html`<md-icon-button id="acp-workspace-picker-new" aria-label="New workspace" @click=${() => this.#emit('acp-workspace-new', null)}>
          <md-icon class="acp-workspace-picker__icon">${unsafeSVG(addTaskIcon)}</md-icon>
        </md-icon-button>
        <md-tooltip for="acp-workspace-picker-new" show-delay="800" placement="bottom">New workspace</md-tooltip>`;
    }
    const current = this.#current;
    const waiting = [...this.workspaces.map((w) => w.id), MAIN].filter((id) => id !== current && this.#status(id) === 'waiting').length;
    return html`<md-button id=${BUTTON_ID} class="acp-workspace-picker__button" variant="text" aria-label="Workspace ${this.#nameOf(current)}">
        <span class="acp-workspace-picker__label">
          <md-icon class="acp-workspace-picker__icon">${unsafeSVG(layersIcon)}</md-icon>
          <span class="acp-workspace-picker__name">${this.#nameOf(current)}</span>
          <acp-workspace-status class="acp-workspace-picker__status" .status=${this.#status(current)}></acp-workspace-status>
          <md-icon class="acp-workspace-picker__arrow ${this.open ? 'acp-workspace-picker__arrow_open' : ''}">${unsafeSVG(expandMoreIcon)}</md-icon>
        </span>
      </md-button>
      <md-tooltip for=${BUTTON_ID} show-delay="800" placement="bottom">Switch workspace</md-tooltip>
      <span class="acp-workspace-picker__live" aria-live="polite"
        >${waiting > 0
          ? html`<md-button class="acp-workspace-picker__badge" variant="tonal" @click=${() => void this.#menu?.show()}>${waiting} waiting</md-button>`
          : nothing}</span
      >
      ${this.#renderMenu()}`;
  }
}

customElements.define('acp-workspace-picker', AcpWorkspacePicker);
