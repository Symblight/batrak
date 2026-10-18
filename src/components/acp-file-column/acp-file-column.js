import { LitElement, html } from 'lit';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import { gitController } from '../../services/git-controller.js';
import { gitLastCommitMessage, listDir } from '../../services/ipc.js';
import { log } from '../../services/logger.js';
import { projectController } from '../../services/project-controller.js';
import { $expandedFolders, setExpandedFolders } from '../../stores/file-tree.js';
import { $commitSelection, $gitChanges, $gitRepo, setCommitSelection } from '../../stores/git.js';
import { notify } from '../../stores/notices.js';
import { $openingPath, $rootId, $workspace } from '../../stores/workspace.js';
import '../acp-file-tree/acp-file-tree.js';
import '../acp-search-panel/acp-search-panel.js';
import '../acp-changes-panel/acp-changes-panel.js';
import styles from './acp-file-column.css?inline';

/** @typedef {'files' | 'search' | 'changes'} SideView */
/** @typedef {import('../../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */

/** @type {Record<SideView, string>} */
const SIDE_TITLES = { files: 'Files', search: 'Search', changes: 'Changes' };

/**
 * @tag acp-file-column
 * @summary The project column: one of Files, Search or Changes, picked from the nav rail.
 */
export class AcpFileColumn extends LitElement {
  static properties = {
    sideView: { state: true },
  };

  static styles = styles;

  #rootId = new StoreController(this, { store: $rootId });
  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  #expandedFolders = new StoreController(this, { store: $expandedFolders });
  /** Picks of files no longer changed are forgotten; not while a scan is pending, when the list is empty. */
  #gitChanges = new StoreController(this, {
    store: $gitChanges,
    onChange: (changes, old) => {
      if (!changes.loaded || (changes.files === old?.files && changes.loaded === old?.loaded)) return;
      const changed = new Set(changes.files.map((file) => file.path));
      setCommitSelection([...$commitSelection.get()].filter((id) => changed.has(id)));
    },
  });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #commitSelection = new StoreController(this, { store: $commitSelection });
  #search = new FindInFilesController(this);
  /** @type {(() => void) | null} Stops watching the changes; set while Changes is shown and connected. */
  #unwatch = null;

  #onFsChange = (/** @type {Event} */ e) => {
    const { dirs } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    this.renderRoot.querySelector('acp-file-tree')?.reload(dirs);
  };

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
  }

  connectedCallback() {
    super.connectedCallback();
    projectController.addEventListener('fs-change', this.#onFsChange);
    this.#watchChanges(this.sideView === 'changes');
  }

  disconnectedCallback() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
    this.#watchChanges(false);
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (!changed.has('sideView')) return;
    // Hidden panes do no work: Search stops its search, Changes stops computing them.
    this.#search.setActive(this.sideView === 'search');
    this.#watchChanges(this.sideView === 'changes');
  }

  /** @param {boolean} watching */
  #watchChanges(watching) {
    if (watching && this.isConnected) this.#unwatch ??= gitController.watchChanges();
    else if (!watching) {
      this.#unwatch?.();
      this.#unwatch = null;
    }
  }

  /** Switches to Files. */
  showFiles() {
    this.sideView = 'files';
  }

  /** Switches to Search and focuses its input. */
  async showSearch() {
    this.sideView = 'search';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-search-panel')?.focusInput();
  }

  /**
   * Switches to Files and selects a file or folder there.
   * @param {string} rel Root-relative.
   * @param {{ expand?: boolean }} [options] Expand the folder itself too.
   */
  async reveal(rel, options) {
    this.sideView = 'files';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-file-tree')?.reveal(rel, options);
  }

  /** Switches to Changes, which computes them while shown. */
  showChanges() {
    this.sideView = 'changes';
  }

  /** @param {Event} e */
  #onSearch(e) {
    const { options, delay } = /** @type {CustomEvent<{ options: SearchOptions, delay: number }>} */ (e).detail;
    this.#search.search(options, delay);
  }

  /** @param {Event} e */
  async #onAmendStart(e) {
    const panel = /** @type {HTMLElementTagNameMap['acp-changes-panel']} */ (e.target);
    const rootId = this.#rootId.value;
    const last = rootId ? await gitLastCommitMessage(rootId).catch(() => null) : null;
    panel.fillAmendMessage(last);
  }

  /** @param {Event} e */
  async #onCommit(e) {
    const panel = /** @type {HTMLElementTagNameMap['acp-changes-panel']} */ (e.target);
    const { paths, message, amend } = /** @type {CustomEvent<{ paths: string[], message: string, amend: boolean }>} */ (
      e
    ).detail;
    try {
      const { sha, summary } = await gitController.commit(paths, message, amend);
      notify('info', `${amend ? 'Amended' : 'Committed'} ${sha}: ${summary}`);
      panel.commitFinished(true);
    } catch (err) {
      // Not `reportError`: a hook's output may quote file contents, which stay out of the log.
      log('warn', `${amend ? 'amend' : 'commit'} failed`);
      notify('error', `Commit failed: ${err instanceof Error ? err.message : String(err)}`);
      panel.commitFinished(false);
    }
  }

  render() {
    const root = this.#workspace.value?.path ?? null;
    const search = this.#search;
    return html`
      <h2 class="acp-file-column__title">${SIDE_TITLES[this.sideView]}</h2>
      <acp-file-tree
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'files'}
        .rootId=${this.#rootId.value}
        .root=${root}
        .listDir=${listDir}
        .expanded=${this.#expandedFolders.value}
        .opening=${this.#openingPath.value !== null}
        @acp-expanded-change=${(/** @type {CustomEvent<{ paths: string[] }>} */ e) => setExpandedFolders(e.detail.paths)}
      ></acp-file-tree>
      <acp-search-panel
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'search'}
        .root=${root}
        .results=${search.results}
        .searching=${search.searching}
        .limitHit=${search.limitHit}
        .error=${search.error}
        @acp-search=${this.#onSearch}
      ></acp-search-panel>
      <acp-changes-panel
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'changes'}
        .changes=${this.#gitChanges.value}
        .repo=${this.#gitRepo.value}
        .selection=${this.#commitSelection.value}
        .root=${root}
        @acp-commit-select=${(/** @type {CustomEvent<{ ids: string[] }>} */ e) => setCommitSelection(e.detail.ids)}
        @acp-changes-refresh=${() => gitController.refreshChanges()}
        @acp-amend-start=${this.#onAmendStart}
        @acp-commit=${this.#onCommit}
      ></acp-changes-panel>
    `;
  }
}

customElements.define('acp-file-column', AcpFileColumn);
