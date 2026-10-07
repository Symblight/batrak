import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/progress-circular';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import { fileIconFor } from '../../models/file-icons.js';
import { listDir } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $openingPath, $rootId } from '../../stores/workspace.js';
import { $projects } from '../../stores/projects.js';
import styles from './acp-file-tree.css?inline';

/** @typedef {import('../../models/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {{ id: string, label: string, isDir: boolean, ignored: boolean }} TreeItem */

/**
 * @param {WorkspaceEntry} e
 * @returns {TreeItem}
 */
function toItem(e) {
  return { id: e.path, label: e.name, isDir: e.isDir, ignored: e.ignored };
}

/**
 * @tag acp-file-tree
 * @summary Lazy file tree of the opened project, reloaded where the file watcher reports changes.
 * @fires acp-file-open `{ path }`
 */
export class AcpFileTree extends LitElement {
  static styles = styles;

  /** Lazy loader for tvx-tree-view: one directory level per expand. */
  #dataSource = {
    /** @param {TreeItem | undefined} parent */
    getTreeItems: async (parent) => {
      const rootId = this.#rootId.value;
      if (rootId === null) return [];
      return (await listDir(rootId, parent?.id ?? '')).map(toItem);
    },
    /** @param {TreeItem} item */
    getChildrenCount: (item) => (item.isDir ? undefined : 0),
  };
  /** A new root lists different files; also fires on connect, before the tree exists. */
  #rootId = new StoreController(this, { store: $rootId, onChange: () => this.#switchProject() });
  /** @type {string | null} Project the tree lists. */
  #project = null;
  /** @type {Map<string, Set<PropertyKey>>} Expanded folders of the other projects, by project path. */
  #expandedByProject = new Map();
  /** @type {Set<PropertyKey> | null} Folders to expand again as their parents load, after a switch. */
  #restoring = null;
  #openingPath = new StoreController(this, { store: $openingPath });
  #onFsChange = (/** @type {Event} */ e) => {
    const { dirs } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const dir of dirs) {
      if (dir === '') this.#tree?.loading.reload();
      else this.#tree?.loading.reload(dir);
    }
  };

  /** Lists the active project, with the folders expanded that were when it was last shown. */
  #switchProject() {
    const tree = this.#tree;
    if (tree && this.#project !== null) this.#expandedByProject.set(this.#project, tree.expansion.get());
    this.#project = projectController.path;
    const projects = new Set($projects.get().map((p) => p.id));
    for (const path of this.#expandedByProject.keys()) {
      if (!projects.has(path)) this.#expandedByProject.delete(path);
    }
    const saved = this.#project === null ? undefined : this.#expandedByProject.get(this.#project);
    this.#restoring = saved?.size ? new Set(saved) : null;
    // Ids are relative paths, so the previous project's `src` must not stay expanded here.
    tree?.expansion.set([]);
    tree?.loading.reload();
  }

  /**
   * Expands the remembered folders among the children just loaded; each expansion loads its
   * children in turn, so nested folders open level by level.
   * @param {Event} e
   */
  #onChildrenLoaded(e) {
    const restoring = this.#restoring;
    if (!restoring) return;
    const { items } = /** @type {CustomEvent<{ items: TreeItem[] }>} */ (e).detail;
    for (const item of items) {
      if (!restoring.delete(item.id)) continue;
      this.#tree?.expansion.expand(item.id);
    }
    if (restoring.size === 0) this.#restoring = null;
  }

  /** @returns {HTMLElementTagNameMap['tvx-tree-view'] | null | undefined} */
  get #tree() {
    return this.renderRoot?.querySelector('tvx-tree-view');
  }

  connectedCallback() {
    super.connectedCallback();
    projectController.addEventListener('fs-change', this.#onFsChange);
  }

  disconnectedCallback() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
    super.disconnectedCallback();
  }

  /**
   * Leading icon of a row: folder icon from the tree-view package, language logo from simple-icons, else a Material file icon.
   * @param {TreeItem} item
   * @param {{ expanded: boolean }} state
   */
  #renderLeading(item, { expanded }) {
    return item.isDir
      ? html`<tvx-tree-directory-icon ?expanded=${expanded}></tvx-tree-directory-icon>`
      : html`<md-icon style="font-size: 14px">${unsafeSVG(fileIconFor(item.label) ?? fileIcon)}</md-icon>`;
  }

  /**
   * Ignored entries are dimmed. Rendered inside the tree's shadow root, so styled inline.
   * @param {TreeItem} item
   */
  #renderLabel(item) {
    return item.ignored
      ? html`<span style="color: var(--md-on-surface-variant); opacity: 0.6">${item.label}</span>`
      : item.label;
  }

  /** @param {Event} e */
  #onSelectionChange(e) {
    const { selectedItems } = /** @type {CustomEvent<{ selectedItems: Set<string> }>} */ (e).detail;
    for (const id of selectedItems) {
      const item = /** @type {TreeItem | null} */ (this.#tree?.nodes.getItem(id));
      if (item && !item.isDir) this.#open(item.id);
    }
  }

  /** @param {string} rel */
  #open(rel) {
    this.dispatchEvent(
      new CustomEvent('acp-file-open', {
        detail: { path: projectController.absPath(rel) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const opening = this.#openingPath.value !== null;
    // Hidden rather than removed while a project opens, so `#rootId` can still reload it.
    return html`
      ${opening
        ? html`<div class="acp-file-tree__loading">
            <md-progress-circular class="acp-file-tree__spinner" aria-label="Opening project"></md-progress-circular>
          </div>`
        : nothing}
      <tvx-tree-view
        compact
        class="acp-file-tree__tree"
        ?hidden=${opening}
        .dataSource=${this.#dataSource}
        .renderItemLeading=${this.#renderLeading}
        .renderItemLabel=${this.#renderLabel}
        @tvx-selection-change=${this.#onSelectionChange}
        @tvx-children-loaded=${this.#onChildrenLoaded}
      ></tvx-tree-view>
    `;
  }
}

customElements.define('acp-file-tree', AcpFileTree);
