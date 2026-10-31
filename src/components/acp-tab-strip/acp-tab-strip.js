import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/tabs';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import pushPinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import differenceIcon from '@material-design-icons/svg/outlined/difference.svg?raw';
import settingsIcon from '@material-design-icons/svg/outlined/settings.svg?raw';
import smartToyIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import { fileIconFor } from '../../models/file-icons/file-icons.js';
import { basename, shownPath, worktreeOf } from '../../models/paths/paths.js';
import { sessionOfTab, terminalOfTab } from '../../models/tab-ids/tab-ids.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { SortableController } from '../../controllers/sortable/SortableController.js';
import { TabOverflowController } from '../../controllers/tab-overflow/TabOverflowController.js';
import styles from './acp-tab-strip.css?inline';

/** @typedef {import('../../models/types/types.js').EditorTab} EditorTab */
/** @typedef {import('../../models/types/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../models/types/types.js').TerminalInfo} TerminalInfo */

/** @typedef {'tab' | 'others' | 'right' | 'all'} CloseScope */

const RETURN_DELAY_MS = 2000;

/**
 * @tag acp-tab-strip
 * @summary The main column's row of tabs: activate, close, pin and drag them; scrolls sideways, and lists the tabs out of view under Show Hidden Tabs.
 * @fires acp-tab-activate `{ id }`
 * @fires acp-tab-close-request `{ id, scope, ids }` A `CloseScope` around the tab and the tabs it closes, not yet confirmed.
 * @fires acp-tab-pin `{ id, pinned }`
 * @fires acp-tab-move `{ id, index }`
 * @fires acp-copy-path `{ path }`
 */
export class AcpTabStrip extends LitElement {
  static properties = {
    tabs: { attribute: false },
    active: { attribute: false },
    pinned: { attribute: false },
    root: { attribute: false },
    worktrees: { attribute: false },
    terminals: { attribute: false },
  };

  static styles = styles;

  /** Set when the active tab changes; `updated()` scrolls it into view. */
  #activeChanged = false;
  /** @type {ContextMenuController<EditorTab>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-tab-strip__menu'),
    onSelect: (value, tab) => this.#onMenuSelect(value, tab),
  });
  /** @type {SortableController} Tabs are dragged within their group: pinned among pinned, the others among the others. */
  #sortable = new SortableController(this, {
    selector: '.acp-tab-strip__tab',
    getId: (element) => element.getAttribute('value'),
    axis: 'horizontal',
    container: '.acp-tab-strip__scroller',
    group: (id) => (this.#isPinned(id) ? 'pinned' : 'tabs'),
    onReorder: (id, index) => this.#emit('acp-tab-move', { id, index }),
  });
  /** A plain mouse wheel only scrolls vertically; turn that into scrolling the tab strip. */
  #onWheel = (/** @type {WheelEvent} */ e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const strip = /** @type {HTMLElement} */ (e.currentTarget);
    if (strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  };

  /** @type {ReturnType<typeof setTimeout> | undefined} Brings the active tab back after the strip was scrolled away and left alone. */
  #returnTimer;
  /** Counts down only while the strip is not hovered. */
  #scheduleReturn = () => {
    clearTimeout(this.#returnTimer);
    this.#returnTimer = setTimeout(() => {
      const strip = this.renderRoot.querySelector('.acp-tab-strip__scroller');
      if (strip?.matches(':hover') || this.#sortable.dragging !== null || this.#overflowMenu?.open) return;
      this.#revealActiveTab('instant');
    }, RETURN_DELAY_MS);
  };
  #pauseReturn = () => clearTimeout(this.#returnTimer);

  /** @type {TabOverflowController} */
  #overflow = new TabOverflowController(this, {
    strip: () => this.renderRoot.querySelector('.acp-tab-strip__scroller'),
    observed: () => [...this.renderRoot.querySelectorAll('.acp-tab-strip__scroller, .acp-tab-strip__tabs')],
    // The label, not the tab: its padding may sit under a fade while its title reads in full.
    spans: () =>
      [...this.renderRoot.querySelectorAll('.acp-tab-strip__tab')].map((tab) => {
        const rect = (tab.querySelector('.acp-tab-strip__label') ?? tab).getBoundingClientRect();
        return { id: tab.getAttribute('value') ?? '', start: rect.left, end: rect.right };
      }),
    fade: '--_acp-tab-strip-fade',
    paused: () => this.#sortable.dragging !== null,
  });
  /** @type {{ id: string, index: number } | null} A row Delete closed: once it's gone, the row now at its index takes the focus. */
  #refocus = null;

  /** @returns {HTMLElementTagNameMap['md-menu'] | null} */
  get #overflowMenu() {
    return this.renderRoot.querySelector('.acp-tab-strip__overflow-menu');
  }

  /** The button opens the list under itself, the active row (or the first) focused, and closes it when open. */
  #onOverflowClick = async (/** @type {Event} */ e) => {
    const menu = this.#overflowMenu;
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
  #onOverflowKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'ArrowDown' || this.#overflowMenu?.open) return;
    e.preventDefault();
    /** @type {HTMLElement} */ (e.currentTarget).click();
  };

  #onOverflowSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return; // the item's own `select`; the menu dispatches it again
    this.#emit('acp-tab-activate', { id: /** @type {CustomEvent<{ value: string }>} */ (e).detail.value });
  };

  /** Delete or Backspace on a row closes its tab, the menu staying open. */
  #onOverflowMenuKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const row = e
      .composedPath()
      .find(/** @returns {n is HTMLElement} */ (n) => n instanceof HTMLElement && n.classList.contains('acp-tab-strip__overflow-item'));
    const id = row?.getAttribute('value');
    if (!row || !id) return;
    e.preventDefault();
    e.stopPropagation();
    this.#refocus = { id, index: [...(row.parentElement?.children ?? [])].indexOf(row) };
    this.#closeOrUnpin(id);
  };

  #onOverflowOpening = () => {
    const menu = this.#overflowMenu;
    if (menu) ContextMenuController.showOnly(menu);
    this.requestUpdate(); // the button's aria-expanded
  };

  #onOverflowClosed = () => {
    this.#refocus = null;
    this.requestUpdate();
    this.#scheduleReturn();
  };

  constructor() {
    super();
    /** @type {readonly EditorTab[]} In strip order. */
    this.tabs = [];
    /** @type {string | null} The active tab's id. */
    this.active = null;
    /** @type {readonly string[]} Pinned tabs' ids. */
    this.pinned = [];
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {readonly WorktreeFolder[]} Worktree sessions' folders, whose files are marked. */
    this.worktrees = [];
    /** @type {Readonly<Record<string, TerminalInfo>>} Terminal tabs' shells, by terminal id. */
    this.terminals = {};
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#returnTimer);
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('active')) this.#activeChanged = true;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  updated(changed) {
    if (changed.has('tabs') || changed.has('pinned')) this.#overflow.schedule();
    this.#updateOverflowMenu();
    if (!this.#activeChanged) return;
    this.#activeChanged = false;
    this.#revealActiveTab();
  }

  /** Closes the list once no row is left, and moves the focus off a row Delete closed. */
  #updateOverflowMenu() {
    const menu = this.#overflowMenu;
    if (!menu?.open) return;
    const rows = /** @type {HTMLElementTagNameMap['md-menu-item'][]} */ ([
      ...menu.querySelectorAll('.acp-tab-strip__overflow-item'),
    ]);
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
   * Scrolls the strip so the active tab is fully visible.
   * @param {ScrollBehavior} [behavior] Defaults to the strip's own (smooth).
   */
  async #revealActiveTab(behavior = 'auto') {
    const tab = [...this.renderRoot.querySelectorAll('md-tab')].find((t) => t.getAttribute('value') === this.active);
    // The tab lays out after it upgrades; scroll once it has.
    await tab?.updateComplete;
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  }

  /** @param {string} id */
  #isPinned(id) {
    return this.pinned.includes(id);
  }

  /**
   * @param {string} id
   * @param {CloseScope} scope
   * @param {string[]} ids The tabs it closes.
   */
  #close(id, scope, ids) {
    this.#emit('acp-tab-close-request', { id, scope, ids });
  }

  /**
   * The tab's button: closes it, or unpins it when pinned.
   * @param {Event} e
   * @param {string} id
   */
  #onCloseClick(e, id) {
    e.stopPropagation(); // don't let the tab (or its row in Show Hidden Tabs) activate itself
    this.#closeOrUnpin(id);
  }

  /** @param {string} id */
  #closeOrUnpin(id) {
    if (this.#isPinned(id)) this.#emit('acp-tab-pin', { id, pinned: false });
    else this.#close(id, 'tab', [id]);
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} id
   */
  #onCloseKey(e, id) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.#onCloseClick(e, id);
  }

  /**
   * @param {string} value The chosen item's.
   * @param {EditorTab} tab The tab the menu was opened on.
   */
  #onMenuSelect(value, tab) {
    const ids = this.tabs.map((t) => t.id);
    const closable = ids.filter((id) => !this.#isPinned(id));
    const index = ids.indexOf(tab.id);
    if (value === 'close') this.#close(tab.id, 'tab', [tab.id]);
    else if (value === 'close-others') this.#close(tab.id, 'others', closable.filter((id) => id !== tab.id));
    else if (value === 'close-right') this.#close(tab.id, 'right', closable.filter((id) => ids.indexOf(id) > index));
    else if (value === 'close-all') this.#close(tab.id, 'all', closable);
    else if (value === 'pin' || value === 'unpin') this.#emit('acp-tab-pin', { id: tab.id, pinned: value === 'pin' });
    else if (value === 'copy-path') this.#emit('acp-copy-path', { path: tab.path });
  }

  /**
   * Title, icon and tooltip of a tab.
   * @param {EditorTab} tab
   * @returns {{ title: string, icon: string, tooltip: string }}
   */
  #describe(tab) {
    if (tab.kind === 'settings') return { title: 'Settings', icon: settingsIcon, tooltip: 'Settings' };
    if (tab.kind === 'agents') return { title: 'Agents', icon: smartToyIcon, tooltip: 'ACP agents: switch, update and add' };
    if (tab.kind === 'changes') {
      return { title: 'Changes', icon: differenceIcon, tooltip: 'Changed files and their diffs against HEAD' };
    }
    if (tab.kind === 'session-changes') {
      const worktree = this.worktrees.find((w) => w.sessionId === sessionOfTab(tab.id));
      const branch = worktree?.branch ?? 'its worktree';
      return { title: worktree?.title ?? 'Changes', icon: differenceIcon, tooltip: `Changes on ${branch} since the session started` };
    }
    if (tab.kind === 'terminal') {
      const info = this.terminals[terminalOfTab(tab.id) ?? ''];
      return { title: info?.title ?? info?.label ?? 'Terminal', icon: terminalIcon, tooltip: info?.login ?? info?.cwd ?? 'Terminal' };
    }
    if (tab.kind === 'browser') return { title: 'Browser', icon: languageIcon, tooltip: 'Browser' };
    const name = basename(tab.path);
    const path = shownPath(this.root, this.worktrees, tab.path);
    const worktree = worktreeOf(this.worktrees, tab.path);
    if (worktree) return { title: name, icon: branchIcon, tooltip: `${path} in worktree ${worktree.branch}` };
    return { title: name, icon: fileIconFor(name) ?? fileIcon, tooltip: path };
  }

  /** @param {EditorTab} tab */
  #renderTab(tab) {
    const { title, icon, tooltip } = this.#describe(tab);
    const pinned = this.#isPinned(tab.id);
    const id = `tab-${tab.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    const dragging = this.#sortable.dragging;
    return html`<md-tab
      id=${id}
      class=${classMap({
        'acp-tab-strip__tab': true,
        'acp-tab-strip__tab_sorting': dragging !== null,
        'acp-tab-strip__tab_dragging': dragging === tab.id,
      })}
      style=${styleMap({ '--_acp-tab-strip-shift': `${this.#sortable.offsetOf(tab.id)}px` })}
      value=${tab.id}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#menu.onContextMenu(tab, e)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#menu.onKeydown(tab, e)}
    >
      <md-tooltip class="acp-tab-strip__tooltip" for=${id} placement="bottom" show-delay="800">${tooltip}</md-tooltip>
      ${tab.draft !== null
        ? html`<md-tooltip for="${id}-unsaved" placement="top" show-delay="800">Unsaved changes</md-tooltip>`
        : nothing}
      <md-tooltip for="${id}-close" placement="top" show-delay="800">${pinned ? 'Unpin' : 'Close'}</md-tooltip>
      <span
        class=${classMap({ 'acp-tab-strip__label': true, 'acp-tab-strip__label_deleted': tab.deletedOnDisk })}
      >
        <md-icon class="acp-tab-strip__file-icon">${unsafeSVG(icon)}</md-icon>
        ${title}
        ${tab.draft !== null ? html`<span id="${id}-unsaved" class="acp-tab-strip__unsaved">●</span>` : nothing}
        <span
          id="${id}-close"
          class="acp-tab-strip__close"
          role="button"
          tabindex="0"
          aria-label="${pinned ? 'Unpin' : 'Close'} ${title}"
          @click=${(/** @type {Event} */ e) => this.#onCloseClick(e, tab.id)}
          @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onCloseKey(e, tab.id)}
          ><md-icon class="acp-tab-strip__close-icon">${unsafeSVG(pinned ? pushPinIcon : closeIcon)}</md-icon></span
        >
      </span>
    </md-tab>`;
  }

  #renderMenu() {
    const tab = this.#menu.target;
    const ids = this.tabs.map((t) => t.id);
    const pinned = tab !== null && this.#isPinned(tab.id);
    // Only the actions that would do something: the close ones never close pinned tabs.
    const closable = ids.filter((id) => !this.#isPinned(id));
    const index = tab ? ids.indexOf(tab.id) : -1;
    /**
     * @param {boolean} shown
     * @param {string} value
     * @param {string} label
     */
    const item = (shown, value, label) =>
      shown ? html`<md-menu-item value=${value}>${label}</md-menu-item>` : nothing;
    return html`<md-menu
      class="acp-tab-strip__menu"
      aria-label=${tab ? this.#describe(tab).title : 'Tab'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
    >
      ${item(true, 'close', 'Close')}
      ${item(closable.some((id) => id !== tab?.id), 'close-others', 'Close Other Tabs')}
      ${item(closable.some((id) => ids.indexOf(id) > index), 'close-right', 'Close Tabs to the Right')}
      ${item(closable.length > 0, 'close-all', 'Close All Tabs')}
      <md-hr></md-hr>
      ${item(true, pinned ? 'unpin' : 'pin', pinned ? 'Unpin Tab' : 'Pin Tab')}
      ${item(tab?.kind === 'file', 'copy-path', 'Copy Path')}
    </md-menu>`;
  }

  /** Show Hidden Tabs: only while the tabs overflow the strip. */
  #renderOverflowButton() {
    if (!this.#overflow.overflowing) return nothing;
    return html`<md-icon-button
        id="overflow"
        class="acp-tab-strip__overflow"
        aria-label="Show Hidden Tabs"
        aria-haspopup="menu"
        aria-expanded=${this.#overflowMenu?.open ? 'true' : 'false'}
        @click=${this.#onOverflowClick}
        @keydown=${this.#onOverflowKeydown}
        ><md-icon class="acp-tab-strip__overflow-icon">${unsafeSVG(expandMoreIcon)}</md-icon></md-icon-button
      >
      <md-tooltip class="acp-tab-strip__tooltip" for="overflow" placement="bottom" show-delay="800">Show Hidden Tabs</md-tooltip>`;
  }

  /** The tabs out of the strip's view, in strip order. */
  #renderOverflowMenu() {
    const hidden = new Set(this.#overflow.hidden);
    return html`<md-menu
      class="acp-tab-strip__overflow-menu"
      aria-label="Hidden Tabs"
      placement="bottom-end"
      focus-on-open="selected"
      @opening=${this.#onOverflowOpening}
      @closed=${this.#onOverflowClosed}
      @select=${this.#onOverflowSelect}
      @keydown=${this.#onOverflowMenuKeydown}
    >
      ${repeat(
        this.tabs.filter((t) => hidden.has(t.id)),
        (t) => t.id,
        (t) => this.#renderOverflowItem(t),
      )}
    </md-menu>`;
  }

  /** @param {EditorTab} tab */
  #renderOverflowItem(tab) {
    const { title, icon, tooltip } = this.#describe(tab);
    const pinned = this.#isPinned(tab.id);
    // Tooltips sit in the trailing slot: the default slot's text is the item's typeahead label.
    const id = `overflow-${tab.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    return html`<md-menu-item
      id=${id}
      class="acp-tab-strip__overflow-item"
      value=${tab.id}
      ?selected=${tab.id === this.active}
    >
      <md-icon slot="leading" class="acp-tab-strip__file-icon">${unsafeSVG(icon)}</md-icon>
      <span class=${classMap({ 'acp-tab-strip__overflow-title': true, 'acp-tab-strip__label_deleted': tab.deletedOnDisk })}
        >${title}</span
      >${tab.draft !== null ? html`<span id="${id}-unsaved" class="acp-tab-strip__unsaved">●</span>` : nothing}
      <span
        id="${id}-close"
        slot="trailing"
        class="acp-tab-strip__close acp-tab-strip__overflow-close"
        role="button"
        aria-label="${pinned ? 'Unpin' : 'Close'} ${title}"
        @click=${(/** @type {Event} */ e) => this.#onCloseClick(e, tab.id)}
        ><md-icon class="acp-tab-strip__close-icon">${unsafeSVG(pinned ? pushPinIcon : closeIcon)}</md-icon></span
      >
      <md-tooltip slot="trailing" class="acp-tab-strip__tooltip" for=${id} placement="right" show-delay="800"
        >${tooltip}</md-tooltip
      >
      ${tab.draft !== null
        ? html`<md-tooltip slot="trailing" for="${id}-unsaved" placement="top" show-delay="800">Unsaved changes</md-tooltip>`
        : nothing}
      <md-tooltip slot="trailing" for="${id}-close" placement="top" show-delay="800">${pinned ? 'Unpin' : 'Close'}</md-tooltip>
    </md-menu-item>`;
  }

  render() {
    return html`<div
        class="acp-tab-strip__scroller"
        @wheel=${this.#onWheel}
        @scroll=${this.#overflow.schedule}
        @pointerenter=${this.#pauseReturn}
        @pointerleave=${this.#scheduleReturn}
      >
        <md-tabs
          class="acp-tab-strip__tabs"
          variant="secondary"
          .value=${this.active ?? ''}
          @change=${(/** @type {CustomEvent<{ value: string }>} */ e) => this.#emit('acp-tab-activate', { id: e.detail.value })}
        >
          ${repeat(this.tabs, (t) => t.id, (t) => this.#renderTab(t))}
        </md-tabs>
      </div>
      ${this.#renderOverflowButton()} ${this.#renderMenu()} ${this.#renderOverflowMenu()}`;
  }
}

customElements.define('acp-tab-strip', AcpTabStrip);
