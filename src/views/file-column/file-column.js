import { html } from 'lit';
import myLocationIcon from '@material-design-icons/svg/outlined/my_location.svg?raw';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { projects } from '../../hooks/projects/projects.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $activeRoot } from '../../stores/workspaces/workspaces.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/panel-header/panel-header.js';
import '../../components/pane/pane.js';
import '../files-view/files-view.js';
import '../search-pane/search-pane.js';
import '../git-changes/git-changes.js';

/** @typedef {'files' | 'search' | 'changes'} SideView */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/** @type {Record<SideView, string>} */
const SIDE_TITLES = { files: 'Files', search: 'Search', changes: 'Changes' };

const SELECT_OPENED = { id: 'select-opened', icon: myLocationIcon, label: 'Select opened file' };
const REFRESH = { id: 'refresh', icon: refreshIcon, label: 'Refresh files', tooltip: 'Refresh' };

/**
 * @tag acp-file-column
 * @summary The project column: one of Files, Search or Changes, picked from the nav rail.
 */
export class AcpFileColumn extends ViewElement {
  static properties = {
    sideView: { state: true },
    refreshing: { state: true },
  };

  #activeRoot = new StoreController(this, { store: $activeRoot });
  #activePath = new StoreController(this, { store: $activePath });

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
    /** A Refresh of the tree is running. */
    this.refreshing = false;
  }

  /** Switches to Files. */
  showFiles() {
    this.sideView = 'files';
  }

  /**
   * Switches to Search and focuses its input; with `state` (a search handed over from the dialog),
   * runs that search, its folder and mask as the include / exclude filters.
   * @param {SearchDialogState} [state]
   */
  async showSearch(state) {
    this.sideView = 'search';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-search-pane')?.show(state);
  }

  /**
   * Switches to Files and selects a file or folder there.
   * @param {string} rel Relative to the folder the tree lists (`$activeRoot`).
   * @param {{ expand?: boolean }} [options] Expand the folder itself too.
   */
  async reveal(rel, options) {
    this.sideView = 'files';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-files-view')?.reveal(rel, options);
  }

  /** Switches to Changes, which computes them while it is shown. */
  showChanges() {
    this.sideView = 'changes';
  }

  /** Scans the tree's root again: for changes the watcher missed. */
  async #refreshTree() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.renderRoot.querySelector('acp-files-view')?.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /** @returns {string | null} The active tab's file relative to the listed folder; `null` for a view's tab or a file elsewhere. */
  get #openedRel() {
    const active = this.#activePath.value;
    return active === null ? null : projects.relPath(active);
  }

  get #actions() {
    if (this.sideView !== 'files' || this.#activeRoot.value.rootId === null) return [];
    return [
      { ...SELECT_OPENED, disabled: this.#openedRel === null },
      { ...REFRESH, disabled: this.refreshing },
    ];
  }

  /** @param {Event} e */
  #onHeaderAction = (e) => {
    const { id } = /** @type {CustomEvent<{ id: string }>} */ (e).detail;
    if (id === REFRESH.id) this.#refreshTree();
    const rel = this.#openedRel;
    if (id === SELECT_OPENED.id && rel !== null) this.reveal(rel);
  };

  render() {
    return html`<acp-panel>
      <acp-panel-header
        slot="header"
        heading=${SIDE_TITLES[this.sideView]}
        .actions=${this.#actions}
        @acp-panel-header-action=${this.#onHeaderAction}
      ></acp-panel-header>
      <acp-pane ?hidden=${this.sideView !== 'files'}><acp-files-view></acp-files-view></acp-pane>
      <acp-pane ?hidden=${this.sideView !== 'search'}>
        <acp-search-pane ?active=${this.sideView === 'search'}></acp-search-pane>
      </acp-pane>
      <acp-pane ?hidden=${this.sideView !== 'changes'}>
        <acp-git-changes ?active=${this.sideView === 'changes'}></acp-git-changes>
      </acp-pane>
    </acp-panel>`;
  }
}

customElements.define('acp-file-column', AcpFileColumn);
