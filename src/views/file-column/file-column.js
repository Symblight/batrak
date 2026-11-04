import { html } from 'lit';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
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

const REFRESH = { icon: refreshIcon, label: 'Refresh files', tooltip: 'Refresh' };

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

  render() {
    const tree = this.#activeRoot.value;
    return html`<acp-panel>
      <acp-panel-header
        slot="header"
        heading=${SIDE_TITLES[this.sideView]}
        .action=${this.sideView === 'files' && tree.rootId !== null ? REFRESH : null}
        ?action-disabled=${this.refreshing}
        @acp-panel-header-action=${this.#refreshTree}
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
