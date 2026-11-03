import { html } from 'lit';
import { app } from '../../hooks/app/app.js';
import { projects } from '../../hooks/projects/projects.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $expandedFolders, setExpandedFolders } from '../../stores/file-tree/file-tree.js';
import { $sessionRootOpening, $treeRoot } from '../../stores/session-root/session-root.js';
import { $openingPath } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/file-tree/file-tree.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/git/types.js').RootChanges} RootChanges */

/**
 * @tag acp-files-view
 * @summary The file tree wired to its data: the listed folder (the project's, or the shown worktree session's), its expanded folders, the folders listed again when files change on disk, and Refresh.
 */
export class AcpFilesView extends ViewElement {
  #treeRoot = new StoreController(this, { store: $treeRoot });
  #openingPath = new StoreController(this, { store: $openingPath });
  #sessionRootOpening = new StoreController(this, { store: $sessionRootOpening });
  #expandedFolders = new StoreController(this, { store: $expandedFolders });
  /** A Refresh is running. */
  #refreshing = false;
  /** Stops listening to the active project's files changing on disk. */
  #stopWatching = () => {};
  /** Stops listening to the shown worktree session's folder. */
  #stopWatchingSessionRoot = () => {};

  get #tree() {
    return /** @type {HTMLElementTagNameMap['acp-file-tree'] | null} */ (this.renderRoot.querySelector('acp-file-tree'));
  }

  #onFsChange = (/** @type {RootChanges} */ { rootId, dirs }) => {
    if (rootId === $treeRoot.get().rootId) this.#tree?.reload(dirs);
  };

  connectedCallback() {
    super.connectedCallback();
    this.#stopWatching = projects.onFsChange(this.#onFsChange);
    this.#stopWatchingSessionRoot = sessions.onRootFsChange(this.#onFsChange);
  }

  disconnectedCallback() {
    this.#stopWatching();
    this.#stopWatchingSessionRoot();
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
    const { rootId } = $treeRoot.get();
    if (rootId === null || this.#refreshing) return;
    this.#refreshing = true;
    try {
      await projects.rescan(rootId);
      if ($treeRoot.get().rootId === rootId) this.#tree?.reload(['', ...$expandedFolders.get()]);
    } catch (err) {
      app.reportError('Refresh failed', err);
    } finally {
      this.#refreshing = false;
    }
  }

  render() {
    const tree = this.#treeRoot.value;
    return html`<acp-file-tree
      .rootId=${tree.rootId}
      .root=${tree.path}
      .rootLabel=${tree.label}
      .listDir=${projects.listDir}
      .expanded=${this.#expandedFolders.value}
      .opening=${this.#openingPath.value !== null || this.#sessionRootOpening.value}
      @acp-expanded-change=${(/** @type {CustomEvent<{ paths: string[] }>} */ e) => {
        e.stopPropagation();
        setExpandedFolders(e.detail.paths);
      }}
    ></acp-file-tree>`;
  }
}

customElements.define('acp-files-view', AcpFilesView);
