import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import { fileIconFor } from '../../models/file-icons/file-icons.js';
import { absPath } from '../../models/paths/paths.js';
import styles from './file-tree.css?inline';

/** @typedef {import('../../models/types/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {{ id: string, label: string, isDir: boolean, ignored: boolean, path?: string }} TreeItem `path`: the root row's folder. */
/** @typedef {(rootId: string, rel: string) => Promise<WorkspaceEntry[]>} ListDir A folder's entries; `''` is the root. */

/**
 * @param {WorkspaceEntry} e
 * @returns {TreeItem}
 */
function toItem(e) {
  return { id: e.path, label: e.name, isDir: e.isDir, ignored: e.ignored };
}

/** Id of the root row; no root-relative path is `/`. Its children are the root's entries (`''`). */
const ROOT_ID = '/';

/**
 * Tooltip of a row's icon and label: its project-relative path, or the root row's folder.
 * @param {TreeItem} item
 */
function tooltipFor(item) {
  if (item.path !== undefined) return item.path;
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
 * @summary Lazy file tree of the opened project, a folder listed as it expands; controlled by its
 *   `expanded` folders. With a `rootLabel`, its entries sit under one root row.
 * @fires acp-file-open `{ path }`
 * @fires acp-expanded-change `{ paths }` Root-relative folders to keep expanded.
 */
export class AcpFileTree extends LitElement {
  static properties = {
    rootId: { attribute: false },
    root: { attribute: false },
    rootLabel: { attribute: false },
    listDir: { attribute: false },
    expanded: { attribute: false },
    opening: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string | null} The project's snapshot id; `null` while none is open. */
    this.rootId = null;
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {string | null} The root row's label (a worktree's name); `null`: no root row. */
    this.rootLabel = null;
    /** @type {ListDir} */
    this.listDir = async () => [];
    /** @type {string[]} Root-relative folders to keep expanded, loaded or not. */
    this.expanded = [];
    /** A project is opening: a spinner shows in place of the tree. */
    this.opening = false;
  }

  /** Lazy loader for tvx-tree-view: one directory level per expand. */
  #dataSource = {
    /** @param {TreeItem | undefined} parent */
    getTreeItems: async (parent) => {
      const rootId = this.rootId;
      if (rootId === null) return [];
      if (!parent && this.rootLabel !== null) {
        return [{ id: ROOT_ID, label: this.rootLabel, isDir: true, ignored: false, path: this.root ?? '' }];
      }
      const items = await this.listDir(rootId, !parent || parent.id === ROOT_ID ? '' : parent.id);
      // A branch still loading when the project switched would land in the new project's folder of
      // the same name: fail it, so the tree drops it.
      if (this.rootId !== rootId) {
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
  /**
   * The latest `expanded`: what this tree asked for is used before the property comes back with it.
   * The tree mirrors it: the user's expansions are sent up, then applied from it.
   * @type {string[]}
   */
  #expanded = [];
  /** @type {string | null} Root whose top-level folders the tree lists; `null` until they load. */
  #listedRoot = null;
  /** Set while the tree is changed from the store, so its `tvx-expansion-change` isn't written back. */
  #applying = false;
  /** @type {string | null} Root-relative path `reveal()` selects once its folder has loaded. */
  #pendingReveal = null;
  /** @type {Set<string>} Folders listed in this project (`''`: the root), where a missing row is really gone. */
  #listedFolders = new Set();
  /** Set while `reveal()` selects a row, so the selection doesn't open it. */
  #revealing = false;
  /** The root row is expanded; the user may collapse it, which isn't stored. */
  #rootExpanded = true;

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('expanded')) this.#expanded = this.expanded;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  updated(changed) {
    // A new root, or a root row coming or going, lists different files; not on the first render,
    // when the tree lists it anyway.
    const relist =
      (changed.has('rootId') && changed.get('rootId') !== undefined) ||
      (changed.has('rootLabel') && changed.get('rootLabel') !== undefined);
    if (relist) this.#switchProject();
    if (changed.has('expanded')) this.#applyExpansion(this.#expanded);
  }

  /**
   * Lists folders again where the file watcher reports changes.
   * @param {string[]} dirs Root-relative; `''` is the root.
   */
  reload(dirs) {
    for (const dir of dirs) {
      if (dir === '') this.#tree?.loading.reload(this.rootLabel === null ? undefined : ROOT_ID);
      else this.#tree?.loading.reload(dir);
    }
  }

  /** @param {string[]} paths */
  #setExpanded(paths) {
    this.#expanded = paths;
    this.dispatchEvent(new CustomEvent('acp-expanded-change', { detail: { paths }, bubbles: true, composed: true }));
  }

  /** Lists the active project; its folders expand from the store as their parents load. */
  #switchProject() {
    this.#listedRoot = null;
    this.#pendingReveal = null;
    this.#listedFolders.clear();
    this.#rootExpanded = true;
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
    if (!tree || (!force && this.#listedRoot !== this.rootId)) return;
    this.#applying = true;
    try {
      tree.expansion.set(this.rootLabel !== null && this.#rootExpanded ? [ROOT_ID, ...paths] : paths);
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
    if (this.#applying || !tree || this.#listedRoot !== this.rootId) return;
    const { expandedItems } = /** @type {CustomEvent<{ expandedItems: Set<PropertyKey> }>} */ (e).detail;
    this.#rootExpanded = expandedItems.has(ROOT_ID);
    const next = new Set(/** @type {string[]} */ ([...expandedItems].filter((id) => typeof id === 'string' && id !== ROOT_ID)));
    for (const path of this.#expanded) {
      if (tree.nodes.getItem(path) === null) next.add(path);
    }
    this.#setExpanded([...next]);
  }

  /**
   * Expands the stored folders among the children just loaded (each loads its children in turn, so
   * nested folders open level by level), and forgets stored folders that are gone from this level.
   * @param {Event} e
   */
  async #onChildrenLoaded(e) {
    const { id, items } = /** @type {CustomEvent<{ id: string | null, items: TreeItem[] }>} */ (e).detail;
    const rootId = this.rootId;
    // On launch the tree lists before `restore()` opens the root; that empty listing would read as
    // every stored folder being gone.
    if (rootId === null) return;
    if (id === null) this.#listedRoot = rootId;
    // The root row alone: expanding it lists the root's entries, which land below.
    if (id === null && this.rootLabel !== null) {
      await this.#tree?.updateComplete;
      if (this.rootId === rootId) this.#applyExpansion(this.#expanded);
      return;
    }
    const parent = id === null || id === ROOT_ID ? '' : id;
    const present = new Set(items.map((item) => item.id));
    const stored = this.#expanded;
    const gone = stored.filter((path) => parentOf(path) === parent && !present.has(path));
    if (gone.length) {
      this.#setExpanded(stored.filter((path) => !gone.some((g) => path === g || path.startsWith(`${g}/`))));
    }
    // A branch's children are in the tree's model when this fires; top-level items only after its
    // next render (`willUpdate`), and it skips ids it doesn't know yet.
    if (id === null) {
      await this.#tree?.updateComplete;
      if (this.rootId !== rootId) return;
    }
    this.#listedFolders.add(parent);
    this.#applyExpansion(this.#expanded);
    this.#selectPending();
  }

  /**
   * Selects a file or folder and scrolls to it, expanding the folders it's in. Folders not loaded
   * yet load first.
   * @param {string} rel Root-relative.
   * @param {{ expand?: boolean }} [options] Expand the folder itself too, showing its children.
   */
  reveal(rel, { expand = false } = {}) {
    const folders = expand ? [rel] : [];
    for (let dir = parentOf(rel); dir; dir = parentOf(dir)) folders.push(dir);
    const stored = this.#expanded;
    const collapsed = folders.filter((dir) => !stored.includes(dir));
    this.#pendingReveal = rel;
    if (!this.#rootExpanded) {
      this.#rootExpanded = true;
      this.#applyExpansion(stored);
    }
    if (collapsed.length) this.#setExpanded([...stored, ...collapsed]);
    this.#selectPending();
  }

  async #selectPending() {
    const rel = this.#pendingReveal;
    const tree = this.#tree;
    if (rel === null || !tree) return;
    if (tree.nodes.getItem(rel) === null) {
      // It, or a folder it's in, is missing from a listing: it would never load, only appear later.
      for (let path = rel; path; path = parentOf(path)) {
        if (this.#listedFolders.has(parentOf(path)) && tree.nodes.getItem(path) === null) {
          this.#pendingReveal = null;
          return;
        }
      }
      return;
    }
    this.#pendingReveal = null;
    this.#revealing = true;
    try {
      tree.selection.set([rel]);
    } finally {
      this.#revealing = false;
    }
    await tree.navigation.reveal(rel, { align: 'center' });
  }

  /** @returns {HTMLElementTagNameMap['tvx-tree-view'] | null | undefined} */
  get #tree() {
    return this.renderRoot?.querySelector('tvx-tree-view');
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
    const icon = item.id === ROOT_ID
      ? html`<md-icon id=${id} style="font-size: 14px">${unsafeSVG(branchIcon)}</md-icon>`
      : item.isDir
      ? html`<tvx-tree-directory-icon id=${id} ?expanded=${expanded}></tvx-tree-directory-icon>`
      : html`<md-icon id=${id} style="font-size: 14px">${unsafeSVG(fileIconFor(item.label) ?? fileIcon)}</md-icon>`;
    return html`${icon}<md-tooltip for=${id} show-delay="800" style="width: max-content; max-inline-size: none">${tooltipFor(item)}</md-tooltip>`;
  }

  /**
   * Ignored entries are dimmed. Rendered inside the tree's shadow root, so styled inline.
   * @param {TreeItem} item
   */
  #renderLabel(item) {
    const id = `acp-file-tree-label:${item.id}`;
    return html`<span
        id=${id}
        style=${item.ignored ? 'color: var(--acp-color-on-surface-variant); opacity: 0.6' : ''}
        >${item.label}</span
      >
      <md-tooltip for=${id} show-delay="800" style="width: max-content; max-inline-size: none">${tooltipFor(item)}</md-tooltip>`;
  }

  /** @param {Event} e */
  #onSelectionChange(e) {
    if (this.#revealing) return;
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
        detail: { path: absPath(this.root, rel) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const opening = this.opening;
    // Hidden rather than removed while a project opens, so a new `rootId` can still reload it.
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
