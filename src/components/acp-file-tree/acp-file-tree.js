import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import { fileIconFor } from '../../models/file-icons.js';
import { listDir } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $openingPath, $rootId } from '../../stores/workspace.js';
import { $expandedFolders, setExpandedFolders } from '../../stores/file-tree.js';
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
 * Tooltip of a row's icon and label: its project-relative path.
 * @param {TreeItem} item
 */
function tooltipFor(item) {
  return item.ignored ? `${item.id} (ignored)` : item.id;
}

/**
 * @param {string} path Root-relative.
 * @returns {string} Its folder, `''` at the root.
 */
function parentOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * @tag acp-file-tree
 * @summary Lazy file tree of the opened project, reloaded where the file watcher reports changes; its
 *   expanded folders are `$expandedFolders`.
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
      const items = await listDir(rootId, parent?.id ?? '');
      // A branch still loading when the project switched would land in the new project's folder of
      // the same name: fail it, so the tree drops it.
      if (this.#rootId.value !== rootId) {
        // While it was in flight, the new project's folder of that id was skipped as loading; load
        // it once the tree has cleared the flag (it reloads only a folder that is expanded).
        if (parent) queueMicrotask(() => this.#tree?.loading.reload(parent.id));
        throw new DOMException('The project changed', 'AbortError');
      }
      return items.map(toItem);
    },
    /** @param {TreeItem} item */
    getChildrenCount: (item) => (item.isDir ? undefined : 0),
  };
  /** A new root lists different files; also fires on connect, before the tree exists. */
  #rootId = new StoreController(this, { store: $rootId, onChange: () => this.#switchProject() });
  /** The tree mirrors the store: expansions by the user are written there, then applied from it. */
  #expanded = new StoreController(this, {
    store: $expandedFolders,
    onChange: (paths) => this.#applyExpansion(paths),
  });
  /** @type {string | null} Root whose top-level folders the tree lists; `null` until they load. */
  #listedRoot = null;
  /** Set while the tree is changed from the store, so its `tvx-expansion-change` isn't written back. */
  #applying = false;
  #openingPath = new StoreController(this, { store: $openingPath });
  #onFsChange = (/** @type {Event} */ e) => {
    const { dirs } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const dir of dirs) {
      if (dir === '') this.#tree?.loading.reload();
      else this.#tree?.loading.reload(dir);
    }
  };

  /** Lists the active project; its folders expand from the store as their parents load. */
  #switchProject() {
    this.#listedRoot = null;
    const tree = this.#tree;
    if (!tree) return;
    // Ids are relative paths, so the previous project's `src` must not stay expanded here.
    this.#applyExpansion([], { force: true });
    tree.loading.reload();
  }

  /**
   * Expands exactly `paths` among the loaded folders; the tree skips the others, which expand when
   * `#onChildrenLoaded` applies the store again.
   * @param {string[]} paths
   * @param {{ force?: boolean }} [options] Apply even while the tree lists another root.
   */
  #applyExpansion(paths, { force = false } = {}) {
    const tree = this.#tree;
    if (!tree || (!force && this.#listedRoot !== this.#rootId.value)) return;
    this.#applying = true;
    try {
      tree.expansion.set(paths);
    } finally {
      this.#applying = false;
    }
  }

  /**
   * The user expanded or collapsed a folder. The tree only knows loaded folders, so the stored ones
   * it doesn't know (under a folder not loaded yet) are kept.
   * @param {Event} e
   */
  #onExpansionChange(e) {
    const tree = this.#tree;
    if (this.#applying || !tree || this.#listedRoot !== this.#rootId.value) return;
    const { expandedItems } = /** @type {CustomEvent<{ expandedItems: Set<PropertyKey> }>} */ (e).detail;
    const next = new Set(/** @type {string[]} */ ([...expandedItems].filter((id) => typeof id === 'string')));
    for (const path of this.#expanded.value) {
      if (tree.nodes.getItem(path) === null) next.add(path);
    }
    setExpandedFolders([...next]);
  }

  /**
   * Expands the stored folders among the children just loaded (each loads its children in turn, so
   * nested folders open level by level), and forgets stored folders that are gone from this level.
   * @param {Event} e
   */
  async #onChildrenLoaded(e) {
    const { id, items } = /** @type {CustomEvent<{ id: string | null, items: TreeItem[] }>} */ (e).detail;
    const rootId = this.#rootId.value;
    // On launch the tree lists before `restore()` opens the root; that empty listing would read as
    // every stored folder being gone.
    if (rootId === null) return;
    if (id === null) this.#listedRoot = rootId;
    const parent = id ?? '';
    const present = new Set(items.map((item) => item.id));
    const stored = this.#expanded.value;
    const gone = stored.filter((path) => parentOf(path) === parent && !present.has(path));
    if (gone.length) {
      setExpandedFolders(stored.filter((path) => !gone.some((g) => path === g || path.startsWith(`${g}/`))));
    }
    // A branch's children are in the tree's model when this fires; top-level items only after its
    // next render (`willUpdate`), and it skips ids it doesn't know yet.
    if (id === null) {
      await this.#tree?.updateComplete;
      if (this.#rootId.value !== rootId) return;
    }
    this.#applyExpansion(this.#expanded.value);
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
   * Rendered in the tree's shadow root, so each anchor and its tooltip stay in one template.
   * Tooltips get `width: max-content`: wc-material's fixed tooltip otherwise shrinks to the space right of
   * its `left`, so near the window's edge each reposition resizes it and re-fires Floating UI's
   * ResizeObserver ("ResizeObserver loop completed with undelivered notifications").
   * @param {TreeItem} item
   * @param {{ expanded: boolean }} state
   */
  #renderLeading(item, { expanded }) {
    const id = `acp-file-tree-icon:${item.id}`;
    const icon = item.isDir
      ? html`<tvx-tree-directory-icon id=${id} ?expanded=${expanded}></tvx-tree-directory-icon>`
      : html`<md-icon id=${id} style="font-size: 14px">${unsafeSVG(fileIconFor(item.label) ?? fileIcon)}</md-icon>`;
    return html`${icon}<md-tooltip for=${id} style="width: max-content">${tooltipFor(item)}</md-tooltip>`;
  }

  /**
   * Ignored entries are dimmed. Rendered inside the tree's shadow root, so styled inline.
   * @param {TreeItem} item
   */
  #renderLabel(item) {
    const id = `acp-file-tree-label:${item.id}`;
    return html`<span
        id=${id}
        style=${item.ignored ? 'color: var(--md-on-surface-variant); opacity: 0.6' : ''}
        >${item.label}</span
      >
      <md-tooltip for=${id} style="width: max-content">${tooltipFor(item)}</md-tooltip>`;
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
        expansion-trigger="icon"
        class="acp-file-tree__tree"
        ?hidden=${opening}
        .dataSource=${this.#dataSource}
        .renderItemLeading=${this.#renderLeading}
        .renderItemLabel=${this.#renderLabel}
        @tvx-selection-change=${this.#onSelectionChange}
        @tvx-children-loaded=${this.#onChildrenLoaded}
        @tvx-expansion-change=${this.#onExpansionChange}
      ></tvx-tree-view>
    `;
  }
}

customElements.define('acp-file-tree', AcpFileTree);
