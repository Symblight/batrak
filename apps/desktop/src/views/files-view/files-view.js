import { html } from 'lit';
import { app } from '../../hooks/app/app.js';
import { git } from '../../hooks/git/git.js';
import { projects } from '../../hooks/projects/projects.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { $expandedFolders, $fileMarks, setExpandedFolders } from '../../stores/file-tree/file-tree.js';
import { $activeRoot } from '../../stores/workspaces/workspaces.js';
import { $openingPath } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/file-tree/file-tree.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/git/types.js').RootChanges} RootChanges */

/**
 * @tag acp-files-view
 * @summary The file tree wired to its data: the shown folder (the project's, or the shown workspace's), its expanded folders, its rows' git marks, the folders listed again when files change on disk, Refresh, and what a row's menu asks for.
 */
export class AcpFilesView extends ViewElement {
  #activeRoot = new StoreController(this, { store: $activeRoot });
  #openingPath = new StoreController(this, { store: $openingPath });
  #expandedFolders = new StoreController(this, { store: $expandedFolders });
  #fileMarks = new StoreController(this, { store: $fileMarks });
  /** A Refresh is running. */
  #refreshing = false;
  /** Stops listening to the shown folder's files changing on disk. */
  #stopWatching = () => {};
  /** Stops keeping the changed files current, which the rows are marked by. */
  #unwatchChanges = () => {};

  get #tree() {
    return /** @type {HTMLElementTagNameMap['acp-file-tree'] | null} */ (this.renderRoot.querySelector('acp-file-tree'));
  }

  #onFsChange = (/** @type {RootChanges} */ { rootId, dirs }) => {
    if (rootId === $activeRoot.get().rootId) this.#tree?.reload(dirs);
  };

  connectedCallback() {
    super.connectedCallback();
    this.#stopWatching = projects.onFsChange(this.#onFsChange);
    this.#unwatchChanges = git.watchChanges();
  }

  disconnectedCallback() {
    this.#stopWatching();
    this.#unwatchChanges();
    super.disconnectedCallback();
  }

  /**
   * Selects a file or folder in the tree, expanding the folders it is in.
   * @param {string} rel Relative to the folder the tree lists.
   * @param {{ expand?: boolean }} [options] Expand the folder itself too.
   */
  reveal(rel, options) {
    this.#tree?.reveal(rel, options);
  }

  /** Scans the listed folder again, then lists its open folders again: for changes the watcher missed. */
  async refresh() {
    const { rootId } = $activeRoot.get();
    if (rootId === null || this.#refreshing) return;
    this.#refreshing = true;
    try {
      await projects.rescan(rootId);
      if ($activeRoot.get().rootId === rootId) this.#tree?.reload(['', ...$expandedFolders.get()]);
    } catch (err) {
      app.reportError('Refresh failed', err);
    } finally {
      this.#refreshing = false;
    }
  }

  /** @param {Event} e */
  #onReveal = (e) => {
    e.stopPropagation();
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    projects.reveal(path).catch((err) => app.reportError(`${app.revealLabel} failed`, err));
  };

  /** @param {Event} e */
  #onOpenTerminal = (e) => {
    e.stopPropagation();
    terminals.openAt(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path);
  };

  /** @param {Event} e */
  #onCopy = (e) => {
    e.stopPropagation();
    app.copy(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text, 'Copying the path failed');
  };

  render() {
    const root = this.#activeRoot.value;
    return html`<acp-file-tree
      .rootId=${root.rootId}
      .root=${root.path}
      .listDir=${projects.listDir}
      .expanded=${this.#expandedFolders.value}
      .marks=${this.#fileMarks.value}
      .opening=${this.#openingPath.value !== null || root.opening}
      @acp-expanded-change=${(/** @type {CustomEvent<{ paths: string[] }>} */ e) => {
        e.stopPropagation();
        setExpandedFolders(e.detail.paths);
      }}
      @acp-reveal-path=${this.#onReveal}
      @acp-open-terminal=${this.#onOpenTerminal}
      @acp-copy=${this.#onCopy}
    ></acp-file-tree>`;
  }
}

customElements.define('acp-files-view', AcpFilesView);
