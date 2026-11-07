import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import copyIcon from '@material-design-icons/svg/outlined/content_copy.svg?raw';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import changesIcon from '@material-design-icons/svg/outlined/difference.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import applyIcon from '@material-design-icons/svg/outlined/call_merge.svg?raw';
import checkOutIcon from '@material-design-icons/svg/outlined/alt_route.svg?raw';
import openInIcon from '@material-design-icons/svg/outlined/open_in_new.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { app } from '../../hooks/app/app.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import styles from './workspace-menu.css?inline';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/app/types.js').Platform} Platform */

/**
 * @tag acp-workspace-menu
 * @summary A workspace's ⋯ menu (Main's for no workspace): Rename, Open in, Copy path, Reveal, Changes since base, Apply to Main, Check out branch in Main, Delete; opens from `anchor` or `show()`.
 * @fires acp-workspace-rename-start `{ id }`
 * @fires acp-open-terminal `{ path }`
 * @fires acp-copy `{ text }` Its folder's path.
 * @fires acp-reveal-path `{ path }`
 * @fires acp-workspace-changes `{ id }`
 * @fires acp-workspace-apply `{ id }`
 * @fires acp-workspace-check-out `{ id }`
 * @fires acp-workspace-delete-request `{ id }`
 * @fires acp-workspace-menu-toggle `{ open }`
 */
export class AcpWorkspaceMenu extends LitElement {
  static properties = {
    workspace: { attribute: false },
    mainFolder: { attribute: false },
    anchor: { attribute: false },
    platform: {},
  };

  static styles = styles;

  /** @type {WeakSet<object>} Picks reported, by their event detail (md-menu repeats a submenu's). */
  #picked = new WeakSet();

  constructor() {
    super();
    /** @type {Workspace | null} `null`: Main. */
    this.workspace = null;
    /** @type {string | null} Main's folder: the project's. */
    this.mainFolder = null;
    /** @type {HTMLElement | null} Places the menu. */
    this.anchor = null;
    /** @type {Platform} Names Reveal. */
    this.platform = app.platform;
  }

  /** @returns {HTMLElementTagNameMap['md-menu'] | null} */
  get menu() {
    return this.renderRoot?.querySelector('md-menu') ?? null;
  }

  show() {
    const menu = this.menu;
    if (!menu) return;
    ContextMenuController.showOnly(menu);
    menu.show();
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const detail = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (this.#picked.has(detail)) return;
    this.#picked.add(detail);
    const path = this.workspace?.folder ?? this.mainFolder;
    const id = this.workspace?.id;
    switch (detail.value) {
      case 'open-terminal':
        if (path) this.#emit('acp-open-terminal', { path });
        return;
      case 'copy-path':
        if (path) this.#emit('acp-copy', { text: path });
        return;
      case 'reveal':
        if (path) this.#emit('acp-reveal-path', { path });
        return;
      case 'rename':
      case 'changes':
      case 'apply':
      case 'check-out':
      case 'delete':
        if (id === undefined) return;
        this.#emit(
          { rename: 'acp-workspace-rename-start', changes: 'acp-workspace-changes', apply: 'acp-workspace-apply', 'check-out': 'acp-workspace-check-out', delete: 'acp-workspace-delete-request' }[detail.value],
          { id },
        );
    }
  };

  /**
   * @param {string} value
   * @param {string} icon
   * @param {unknown} label
   * @param {string} [modifier]
   */
  #item(value, icon, label, modifier = '') {
    return html`<md-menu-item class="acp-workspace-menu__item ${modifier}" value=${value}>
      <md-icon slot="leading">${unsafeSVG(icon)}</md-icon>
      ${label}
    </md-menu-item>`;
  }

  render() {
    const workspace = this.workspace;
    return html`<md-menu
      class="acp-workspace-menu__menu"
      placement="bottom-start"
      aria-label=${workspace?.name ?? 'Main'}
      .anchorElement=${this.anchor ?? undefined}
      @select=${this.#onSelect}
      @opening=${() => this.#emit('acp-workspace-menu-toggle', { open: true })}
      @closing=${() => this.#emit('acp-workspace-menu-toggle', { open: false })}
    >
      ${workspace ? html`<md-item-group>${this.#item('rename', editIcon, html`Rename <span slot="trailing">F2</span>`)}</md-item-group>` : nothing}
      <md-item-group>
        <md-menu-item class="acp-workspace-menu__item" value="open-in">
          <md-icon slot="leading">${unsafeSVG(openInIcon)}</md-icon>
          Open in
          <md-menu slot="submenu" class="acp-workspace-menu__menu" aria-label="Open in">${this.#item('open-terminal', terminalIcon, 'Terminal')}</md-menu>
        </md-menu-item>
        ${this.#item('copy-path', copyIcon, 'Copy path')} ${this.#item('reveal', folderOpenIcon, app.revealLabels[this.platform])}
      </md-item-group>
      ${workspace
        ? html`<md-item-group>
              ${this.#item('changes', changesIcon, 'Changes since base…')} ${this.#item('apply', applyIcon, 'Apply to Main')}
              ${this.#item('check-out', checkOutIcon, 'Check out branch in Main')}
            </md-item-group>
            <md-item-group>${this.#item('delete', deleteIcon, 'Delete workspace…', 'acp-workspace-menu__item_danger')}</md-item-group>`
        : nothing}
    </md-menu>`;
  }
}

customElements.define('acp-workspace-menu', AcpWorkspaceMenu);
