import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import agentTitleIcon from '@material-design-icons/svg/outlined/auto_awesome.svg?raw';
import archiveIcon from '@material-design-icons/svg/outlined/archive.svg?raw';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import downloadIcon from '@material-design-icons/svg/outlined/download.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import openInIcon from '@material-design-icons/svg/outlined/open_in_new.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import styles from './acp-session-menu.css?inline';

/**
 * @tag acp-session-menu
 * @summary A session's menu, shared by its header and its list row: opens from `anchor`, at a point, or driven through `menu`; one menu shows at a time, app-wide; items whose backend isn't there yet are disabled.
 * @fires acp-session-menu-select `{ value }` `rename`, `reset-title`, `reveal` or `delete`.
 * @fires acp-session-menu-toggle `{ open }` As it starts opening or closing.
 * @fires acp-session-menu-closed `null` Once closed, after its animation (it may have reopened since).
 */
export class AcpSessionMenu extends LitElement {
  static properties = {
    anchor: { attribute: false },
    sessionTitle: { attribute: 'session-title' },
    resettable: { type: Boolean },
  };

  static styles = styles;

  /** The anchor whose clicks open the menu. @type {HTMLElement | null} */
  #wired = null;

  constructor() {
    super();
    /** @type {HTMLElement | null} Opens the menu on a click, and places it. */
    this.anchor = null;
    /** @type {string} */
    this.sessionTitle = '';
    /** @type {boolean} The user renamed a session the agent had named: offers its title back. */
    this.resettable = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#wire(this.anchor);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#wire(null);
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('anchor')) this.#wire(this.anchor);
  }

  /**
   * md-menu wires only a `for` anchor in its own root; `anchorElement` just places it.
   * @param {HTMLElement | null} anchor
   */
  #wire(anchor) {
    if (anchor === this.#wired) return;
    this.#wired?.removeEventListener('click', this.#onAnchorClick);
    this.#wired?.removeAttribute('aria-haspopup');
    this.#wired?.removeAttribute('aria-expanded');
    this.#wired = anchor;
    anchor?.addEventListener('click', this.#onAnchorClick);
    anchor?.setAttribute('aria-haspopup', 'menu');
    anchor?.setAttribute('aria-expanded', 'false');
  }

  // md-menu's light dismiss ignores clicks on its anchor, so this is what closes it again.
  #onAnchorClick = () => {
    this.menu?.toggle();
  };

  /** @param {boolean} open */
  #onToggle(open) {
    const menu = this.menu;
    if (open && menu) ContextMenuController.showOnly(menu);
    this.#wired?.setAttribute('aria-expanded', String(open));
    this.#emit('acp-session-menu-toggle', { open });
  }

  /** @returns {HTMLElementTagNameMap['md-menu'] | null} The menu itself, for a `ContextMenuController`. */
  get menu() {
    return this.renderRoot?.querySelector('md-menu') ?? null;
  }

  /**
   * Opens the menu at viewport coordinates (a context menu).
   * @param {number} x
   * @param {number} y
   */
  openAtPoint(x, y) {
    const menu = this.menu;
    if (!menu) return;
    ContextMenuController.showOnly(menu);
    menu.openAtPoint(x, y);
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #onSelect = (/** @type {Event} */ e) => {
    // A submenu's pick reaches the outer menu too; md-menu re-dispatches it as its own.
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    this.#emit('acp-session-menu-select', { value });
  };

  render() {
    return html`<md-menu
      class="acp-session-menu__menu"
      placement="bottom-start"
      aria-label=${this.sessionTitle}
      .anchorElement=${this.anchor ?? undefined}
      @select=${this.#onSelect}
      @opening=${() => this.#onToggle(true)}
      @closing=${() => this.#onToggle(false)}
      @closed=${() => this.#emit('acp-session-menu-closed', null)}
    >
      <md-item-group>
        <md-menu-item class="acp-session-menu__item" value="open-in" disabled>
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(openInIcon)}</md-icon>
          Open in
          <md-menu slot="submenu" class="acp-session-menu__menu" aria-label="Open in">
            <md-menu-item class="acp-session-menu__item" value="open-terminal" disabled>
              <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(terminalIcon)}</md-icon>
              Terminal
            </md-menu-item>
          </md-menu>
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-session-menu__item" value="rename">
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(editIcon)}</md-icon>
          Rename
          <span slot="trailing">F2</span>
        </md-menu-item>
        ${this.resettable
          ? html`<md-menu-item class="acp-session-menu__item" value="reset-title">
              <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(agentTitleIcon)}</md-icon>
              Reset to agent title
            </md-menu-item>`
          : nothing}
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-session-menu__item" value="reveal">
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(folderOpenIcon)}</md-icon>
          Reveal workspace in Files
        </md-menu-item>
        <md-menu-item class="acp-session-menu__item" value="export" disabled>
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(downloadIcon)}</md-icon>
          Export transcript (Markdown)
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-session-menu__item" value="archive" disabled>
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(archiveIcon)}</md-icon>
          Archive
        </md-menu-item>
        <md-menu-item class="acp-session-menu__item acp-session-menu__item_danger" value="delete">
          <md-icon slot="leading" class="acp-session-menu__icon">${unsafeSVG(deleteIcon)}</md-icon>
          Delete…
        </md-menu-item>
      </md-item-group>
    </md-menu>`;
  }
}

customElements.define('acp-session-menu', AcpSessionMenu);
