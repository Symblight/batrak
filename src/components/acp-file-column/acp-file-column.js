import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import { gitController } from '../../services/git-controller.js';
import { gitLastCommitMessage, listDir, rescanWorkspace } from '../../services/ipc.js';
import { log } from '../../services/logger.js';
import { reportError } from '../../services/notices.js';
import { projectController } from '../../services/project-controller.js';
import { sessionRootController } from '../../services/session-root-controller.js';
import { $expandedFolders, setExpandedFolders } from '../../stores/file-tree.js';
import { $commitSelection, $gitChanges, $gitRepo, setCommitSelection } from '../../stores/git.js';
import { notify } from '../../stores/notices.js';
import { $sessionRootOpening, $treeRoot } from '../../stores/session-root.js';
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
    refreshing: { state: true },
  };

  static styles = styles;

  #rootId = new StoreController(this, { store: $rootId });
  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  #treeRoot = new StoreController(this, { store: $treeRoot });
  #sessionRootOpening = new StoreController(this, { store: $sessionRootOpening });
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
  #search = new FindInFilesController(this, { slot: 'panel' });
  /** @type {(() => void) | null} Stops watching the changes; set while Changes is shown and connected. */
  #unwatch = null;

  #onFsChange = (/** @type {Event} */ e) => {
    const { rootId, dirs } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    if (rootId === $treeRoot.get().rootId) this.renderRoot.querySelector('acp-file-tree')?.reload(dirs);
  };

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
    /** A Refresh of the tree is running. */
    this.refreshing = false;
  }

  connectedCallback() {
    super.connectedCallback();
    projectController.addEventListener('fs-change', this.#onFsChange);
    sessionRootController.addEventListener('fs-change', this.#onFsChange);
    this.#watchChanges(this.sideView === 'changes');
  }

  disconnectedCallback() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
    sessionRootController.removeEventListener('fs-change', this.#onFsChange);
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
   * @param {string} rel Relative to the folder the tree lists (`$treeRoot`).
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

  /** Scans the tree's root again, then lists its open folders again: for changes the watcher missed. */
  async #refreshTree() {
    const { rootId } = $treeRoot.get();
    if (rootId === null || this.refreshing) return;
    this.refreshing = true;
    try {
      await rescanWorkspace(rootId);
      if ($treeRoot.get().rootId === rootId) {
        this.renderRoot.querySelector('acp-file-tree')?.reload(['', ...$expandedFolders.get()]);
      }
    } catch (err) {
      reportError('Refresh failed', err);
    } finally {
      this.refreshing = false;
    }
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
    const tree = this.#treeRoot.value;
    return html`
      <div class="acp-file-column__header">
        <h2 class="acp-file-column__title">${SIDE_TITLES[this.sideView]}</h2>
        ${this.sideView === 'files' && tree.rootId !== null
          ? html`<md-icon-button
              id="acp-file-column-refresh"
              class="acp-file-column__refresh"
              aria-label="Refresh files"
              ?disabled=${this.refreshing}
              @click=${this.#refreshTree}
            >
              <md-icon class="acp-file-column__refresh-icon">${unsafeSVG(refreshIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-file-column-refresh" show-delay="800">Refresh</md-tooltip>`
          : nothing}
      </div>
      <acp-file-tree
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'files'}
        .rootId=${tree.rootId}
        .root=${tree.path}
        .rootLabel=${tree.label}
        .listDir=${listDir}
        .expanded=${this.#expandedFolders.value}
        .opening=${this.#openingPath.value !== null || this.#sessionRootOpening.value}
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
