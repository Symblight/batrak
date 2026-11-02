import { projects } from '../../hooks/projects/projects.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/tabs';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import pushPinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import differenceIcon from '@material-design-icons/svg/outlined/difference.svg?raw';
import settingsIcon from '@material-design-icons/svg/outlined/settings.svg?raw';
import smartToyIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import '../file-icon/file-icon.js';
import '../tab-overflow/tab-overflow.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { DropTargetController } from '../../controllers/drop-target/DropTargetController.js';
import { SortableController } from '../../controllers/sortable/SortableController.js';
import { TabOverflowController } from '../../controllers/tab-overflow/TabOverflowController.js';
import styles from './tab-strip.css?inline';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/sessions/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */

/** @typedef {'tab' | 'others' | 'right' | 'all'} CloseScope */

const RETURN_DELAY_MS = 2000;

/**
 * @tag acp-tab-strip
 * @summary The main column's row of tabs: activate, close, pin and drag them; scrolls sideways, and lists the tabs out of view under Show Hidden Tabs.
 * @fires acp-tab-activate `{ id }`
 * @fires acp-tab-close-request `{ id, scope, ids }` A `CloseScope` around the tab and the tabs it closes, not yet confirmed.
 * @fires acp-tab-pin `{ id, pinned }`
 * @fires acp-tab-move `{ id, index }`
 * @fires acp-tab-receive `{ id, index }` A tab of another strip (its `dropTo` is this strip's `dropName`) was dropped here, at that index of this strip.
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
    dropTo: { attribute: false },
    dropName: { attribute: false },
    acceptsDrop: { attribute: false },
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
    dropTo: () => this.dropTo,
  });

  /** @type {{ index: number, step: number } | null} The slot a tab of another strip dragged over this one opens. */
  #slot = null;
  /** @type {number[] | null} The tabs' midpoints when that drag came over, before they slid. */
  #mids = null;
  /** @type {DropTargetController} Takes tabs dragged out of another strip, when this one has a `dropName`. */
  #dropTarget = new DropTargetController(this, {
    name: () => this.dropName,
    area: () => this,
    accepts: (id) => this.acceptsDrop?.(id) ?? false,
    over: (_id, { x }, step) => {
      this.#mids ??= [...this.renderRoot.querySelectorAll('.acp-tab-strip__tab')].map((tab) => {
        const rect = tab.getBoundingClientRect();
        return rect.left + rect.width / 2;
      });
      const index = Math.max(this.pinned.length, this.#mids.filter((mid) => mid < x).length);
      if (this.#slot?.index === index && this.#slot.step === step) return;
      this.#slot = { index, step };
      this.requestUpdate();
    },
    leave: () => {
      this.#mids = null;
      if (this.#slot === null) return;
      this.#slot = null;
      this.requestUpdate();
    },
    drop: (id) => {
      const index = this.#slot?.index ?? this.tabs.length;
      this.#dropTarget.leave();
      this.#emit('acp-tab-receive', { id, index });
    },
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
      if (strip?.matches(':hover') || this.#sortable.dragging !== null || this.#overflowList?.open) return;
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
  /** @returns {HTMLElementTagNameMap['acp-tab-overflow'] | null} */
  get #overflowList() {
    return this.renderRoot.querySelector('acp-tab-overflow');
  }

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
    /** @type {string | null} The name of the strip its tabs may be dragged to (that strip's `dropName`). */
    this.dropTo = null;
    /** @type {string | null} Takes tabs dragged from a strip whose `dropTo` is this name. */
    this.dropName = null;
    /** @type {((id: string) => boolean) | null} Which tabs of another strip it takes. */
    this.acceptsDrop = null;
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
    // A popover opens in the top layer, above every column and clip.
    const ghost = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-tab-strip__ghost'));
    if (ghost && !ghost.matches(':popover-open')) ghost.showPopover();
    if (!this.#activeChanged) return;
    this.#activeChanged = false;
    this.#revealActiveTab();
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
   * Title, icon and tooltip of a tab; `file` is set (and `icon` empty) when the icon is the file's own.
   * @param {EditorTab} tab
   * @returns {{ title: string, icon: string, file: string | null, tooltip: string }}
   */
  #describe(tab) {
    if (tab.kind === 'settings') return { title: 'Settings', icon: settingsIcon, file: null, tooltip: 'Settings' };
    if (tab.kind === 'agents') return { title: 'Agents', icon: smartToyIcon, file: null, tooltip: 'ACP agents: switch, update and add' };
    if (tab.kind === 'changes') {
      return { title: 'Changes', icon: differenceIcon, file: null, tooltip: 'Changed files and their diffs against HEAD' };
    }
    if (tab.kind === 'session-changes') {
      const worktree = this.worktrees.find((w) => w.sessionId === tabs.sessionOf(tab.id));
      const branch = worktree?.branch ?? 'its worktree';
      return { title: worktree?.title ?? 'Changes', icon: differenceIcon, file: null, tooltip: `Changes on ${branch} since the session started` };
    }
    if (tab.kind === 'terminal') {
      const info = this.terminals[tabs.terminalOf(tab.id) ?? ''];
      return { title: info?.title ?? info?.label ?? 'Terminal', icon: terminalIcon, file: null, tooltip: info?.login ?? info?.cwd ?? 'Terminal' };
    }
    if (tab.kind === 'browser') return { title: 'Browser', icon: languageIcon, file: null, tooltip: 'Browser' };
    const name = projects.basename(tab.path);
    const path = projects.shownPath(this.root, this.worktrees, tab.path);
    const worktree = projects.worktreeOf(this.worktrees, tab.path);
    if (worktree) return { title: name, icon: branchIcon, file: null, tooltip: `${path} in worktree ${worktree.branch}` };
    return { title: name, icon: '', file: name, tooltip: path };
  }

  /**
   * A tab's icon: the file's own, or the SVG of a view tab.
   * @param {string} icon
   * @param {string | null} file
   * @param {string} [slot]
   */
  #renderIcon(icon, file, slot) {
    return file !== null
      ? html`<acp-file-icon slot=${ifDefined(slot)} class="acp-tab-strip__file-icon" name=${file}></acp-file-icon>`
      : html`<md-icon slot=${ifDefined(slot)} class="acp-tab-strip__file-icon">${unsafeSVG(icon)}</md-icon>`;
  }

  /**
   * @param {EditorTab} tab
   * @param {number} position In the strip.
   */
  #renderTab(tab, position) {
    const { title, icon, file, tooltip } = this.#describe(tab);
    const pinned = this.#isPinned(tab.id);
    const id = `tab-${tab.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    const dragging = this.#sortable.dragging;
    // A tab of another strip is over this one: the tabs after its slot slide aside.
    const slot = this.#slot;
    const shift = slot && position >= slot.index ? slot.step : this.#sortable.offsetOf(tab.id);
    return html`<md-tab
      id=${id}
      class=${classMap({
        'acp-tab-strip__tab': true,
        'acp-tab-strip__tab_sorting': dragging !== null || slot !== null,
        'acp-tab-strip__tab_dragging': dragging === tab.id,
        'acp-tab-strip__tab_away': dragging === tab.id && this.#sortable.ghost !== null,
      })}
      style=${styleMap({ '--_acp-tab-strip-shift': `${shift}px` })}
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
        ${this.#renderIcon(icon, file)}
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

  /** The tab being dragged to another strip, drawn at the pointer once it is out of this strip (which would clip it). */
  #renderGhost() {
    const at = this.#sortable.ghost;
    const tab = this.tabs.find((t) => t.id === this.#sortable.dragging);
    if (!at || !tab) return nothing;
    const { title, icon, file } = this.#describe(tab);
    return html`<div class="acp-tab-strip__ghost" popover="manual" style=${styleMap({ left: `${at.x}px`, top: `${at.y}px` })}>
      ${this.#renderIcon(icon, file)} ${title}
    </div>`;
  }

  /** Show Hidden Tabs: the tabs out of the strip's view, in strip order. */
  #renderOverflow() {
    const hidden = new Set(this.#overflow.hidden);
    const items = this.tabs
      .filter((t) => hidden.has(t.id))
      .map((tab) => {
        const { title, icon, file, tooltip } = this.#describe(tab);
        return { id: tab.id, title, icon, file, tooltip, pinned: this.#isPinned(tab.id), unsaved: tab.draft !== null, deleted: tab.deletedOnDisk };
      });
    return html`<acp-tab-overflow
      .items=${items}
      .active=${this.active}
      .visible=${this.#overflow.overflowing}
      @acp-tab-overflow-close=${(/** @type {CustomEvent<{ id: string }>} */ e) => {
        e.stopPropagation();
        this.#closeOrUnpin(e.detail.id);
      }}
      @acp-tab-overflow-closed=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#scheduleReturn();
      }}
    ></acp-tab-overflow>`;
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
          ${repeat(this.tabs, (t) => t.id, (t, i) => this.#renderTab(t, i))}
        </md-tabs>
      </div>
      ${this.#renderOverflow()} ${this.#renderMenu()} ${this.#renderGhost()}`;
  }
}

customElements.define('acp-tab-strip', AcpTabStrip);
