import { projects } from '../../hooks/projects/projects.js';
import { search } from '../../hooks/search/search.js';
import { app } from '../../hooks/app/app.js';
import { html } from 'lit';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import { gitController } from '../../services/git-controller/git-controller.js';
import { gitLastCommitMessage, listDir, rescanWorkspace } from '../../services/ipc/ipc.js';
import { sessionRootController } from '../../services/session-root-controller/session-root-controller.js';
import { $expandedFolders, setExpandedFolders } from '../../stores/file-tree/file-tree.js';
import { $commitSelection, $gitChanges, $gitRepo, setCommitSelection } from '../../stores/git/git.js';
import { notify } from '../../stores/notices/notices.js';
import { $sessionRootOpening, $treeRoot } from '../../stores/session-root/session-root.js';
import { $openingPath, $rootId, $workspace } from '../../stores/workspace/workspace.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/panel-header/panel-header.js';
import '../../components/file-tree/file-tree.js';
import '../../components/search-panel/search-panel.js';
import '../../components/changes-panel/changes-panel.js';

/** @typedef {'files' | 'search' | 'changes'} SideView */
/** @typedef {import('../../models/types/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../models/types/types.js').WorkspaceChanges} WorkspaceChanges */

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

  #onFsChange = (/** @type {WorkspaceChanges} */ { rootId, dirs }) => {
    if (rootId === $treeRoot.get().rootId) this.renderRoot.querySelector('acp-file-tree')?.reload(dirs);
  };
  #onSessionRootFsChange = (/** @type {Event} */ e) => this.#onFsChange(/** @type {CustomEvent<WorkspaceChanges>} */ (e).detail);
  /** Stops listening to the active project's files changing on disk. */
  #stopWatching = () => {};

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
    /** A Refresh of the tree is running. */
    this.refreshing = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#stopWatching = projects.onFsChange(this.#onFsChange);
    sessionRootController.addEventListener('fs-change', this.#onSessionRootFsChange);
    this.#watchChanges(this.sideView === 'changes');
  }

  disconnectedCallback() {
    this.#stopWatching();
    sessionRootController.removeEventListener('fs-change', this.#onSessionRootFsChange);
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

  /**
   * Switches to Search and focuses its input; with `state` (a search handed over from the dialog),
   * runs that search, its folder and mask as the include / exclude filters.
   * @param {SearchDialogState} [state]
   */
  async showSearch(state) {
    this.sideView = 'search';
    await this.updateComplete;
    const panel = this.renderRoot.querySelector('acp-search-panel');
    if (state) {
      const { query, caseSensitive, wholeWord, regex, folder, mask } = state;
      panel?.setOptions({ query, caseSensitive, wholeWord, regex, ...search.filters(folder, mask) });
    }
    panel?.focusInput();
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
      app.reportError('Refresh failed', err);
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
  #onSearchOpen(e) {
    e.stopPropagation();
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number }>} */ (
      e
    ).detail;
    const root = this.#workspace.value?.path ?? null;
    this.dispatchEvent(
      new CustomEvent('acp-file-open', { detail: { path: projects.abs(root, path), line, column, length }, bubbles: true, composed: true }),
    );
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
      // Not `app.reportError`: a hook's output may quote file contents, which stay out of the log.
      app.log('warn', `${amend ? 'amend' : 'commit'} failed`);
      notify('error', `Commit failed: ${err instanceof Error ? err.message : String(err)}`);
      panel.commitFinished(false);
    }
  }

  render() {
    const root = this.#workspace.value?.path ?? null;
    const search = this.#search;
    const tree = this.#treeRoot.value;
    return html`<acp-panel>
      <acp-panel-header
        slot="header"
        heading=${SIDE_TITLES[this.sideView]}
        .action=${this.sideView === 'files' && tree.rootId !== null ? REFRESH : null}
        ?action-disabled=${this.refreshing}
        @acp-panel-header-action=${this.#refreshTree}
      ></acp-panel-header>
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
        .results=${search.results}
        .searching=${search.searching}
        .limitHit=${search.limitHit}
        .error=${search.error}
        @acp-search=${this.#onSearch}
        @acp-search-panel-open=${this.#onSearchOpen}
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
    </acp-panel>`;
  }
}

customElements.define('acp-file-column', AcpFileColumn);
