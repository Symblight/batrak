import { projects } from '../../hooks/projects/projects.js';
import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import '@symblight/code-editor';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import { codeEditor } from './code-editor.js';
import { EditorCommentsController } from '../../controllers/comments/EditorCommentsController.js';
import { SelectionActionsController } from '../../controllers/selection-actions/SelectionActionsController.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { ReadOnlyHintController } from '../../controllers/read-only-hint/ReadOnlyHintController.js';
import '../file-icon/file-icon.js';
import { agents } from '../../hooks/agents/agents.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './code-view.css?inline';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/search/types.js').RevealAt} RevealAt */
/** @typedef {import('../../hooks/comments/types.js').AgentThread} AgentThread */
/** @typedef {import('../../hooks/comments/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../hooks/workspaces/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../hooks/projects/types.js').RootEntry} RootEntry */
/** @typedef {import('../file-tree/file-tree.js').ListDir} ListDir */

/**
 * What the footer's file menu is open for: the file, or a folder on its path.
 * @typedef {Object} FooterTarget
 * @property {string} path Absolute: the file, or the folder.
 * @property {boolean} folder
 */

/**
 * A project folder a footer crumb lists, like the IDE's breadcrumbs.
 * @typedef {Object} FolderList
 * @property {string} folder Root-relative; `''` for the root.
 * @property {string} selected Root-relative: the entry on the file's path.
 * @property {RootEntry[]} entries
 */

/**
 * @tag acp-code-view
 * @summary A file tab's code editor, with its footer's file, folder and language menus; agents.json files are editable (Mod+S saves).
 * @fires acp-tab-edit `{ id, value }` An edit in an editable file.
 * @fires acp-tab-save `{ id }` Mod+S in an editable file not changed on disk.
 * @fires acp-tab-conflict `{ id }` Mod+S in an editable file changed on disk since its edits started.
 * @fires acp-tab-language `{ path, language }` A language picked in the footer; `''` for its extension's.
 * @fires acp-copy-path `{ path }`
 * @fires acp-file-reveal `{ path, expand }` Reveal in Files, or a folder picked in a footer crumb's list.
 * @fires acp-file-open `{ path }` A file picked in a footer crumb's list.
 */
export class AcpCodeView extends LitElement {
  static properties = {
    tab: { attribute: false },
    language: { attribute: false },
    root: { attribute: false },
    rootId: { attribute: false },
    workspaces: { attribute: false },
    listDir: { attribute: false },
    comments: { attribute: false },
    commentFocus: { attribute: false },
  };

  static styles = styles;

  /** @type {EditorCommentsController} */
  #comments = new EditorCommentsController(this, {
    pathOf: (file) => file,
    comments: () => this.comments,
    focus: () => this.commentFocus,
  });
  #selectionActions = new SelectionActionsController(this, { pathOf: (file) => file });
  #readOnlyHint = new ReadOnlyHintController(this, { readOnly: () => this.tab !== null && !agents.isAgentsFile(this.tab.path) });
  /** @type {ContextMenuController<FooterTarget>} */
  #fileMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-code-view__file-menu'),
    onSelect: (value, target) => this.#onFileMenuSelect(value, target),
  });
  /** @type {ContextMenuController<FolderList>} */
  #folderMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-code-view__folder-menu'),
    onSelect: (value, list) => this.#onFolderMenuSelect(value, list),
  });
  /** Counts crumb clicks, so a listing that comes back after a newer click is dropped. */
  #folderListing = 0;
  /** @type {ContextMenuController<EditorTab>} */
  #languageMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-code-view__language-menu'),
    onSelect: (language, tab) => this.#emit('acp-tab-language', { path: tab.path, language }),
  });
  /**
   * The footer button pressed last. `cdx-status-click` doesn't say which, and the footer's menus open
   * under it; a capture listener sees the click before the button turns it into that event.
   * @type {HTMLElement | null}
   */
  #statusAnchor = null;

  constructor() {
    super();
    /** @type {EditorTab | null} */
    this.tab = null;
    /** @type {string} The language picked for the file; `''` for its extension's. */
    this.language = '';
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {string | null} The project's snapshot id, for `listDir`; `null` while none is open. */
    this.rootId = null;
    /** @type {readonly WorktreeFolder[]} Workspaces' folders. */
    this.workspaces = [];
    /** @type {ListDir} Lists a project folder for a footer crumb. */
    this.listDir = async () => [];
    /** @type {Readonly<Record<string, readonly AgentThread[]>>} Every file's comments, by absolute path. */
    this.comments = {};
    /** @type {CommentFocus | null} */
    this.commentFocus = null;
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Puts the caret on a line, or selects a range on it, and focuses the editor.
   * @param {RevealAt} at
   */
  async revealLine(at) {
    await this.updateComplete;
    const editor = this.renderRoot.querySelector('cdx-code-editor');
    if (!editor) return;
    await editor.updateComplete;
    if (typeof at === 'number') {
      editor.navigation.goToLine(at);
    } else {
      editor.navigation.goToLine(at.line, at.column);
      const from = editor.doc.posAt(at.line, at.column);
      editor.selection.set(from, from + at.length);
    }
    editor.focus();
  }

  /** The editor's selected text, `''` when none. */
  selectedText() {
    return this.renderRoot.querySelector('cdx-code-editor')?.selection.getText() ?? '';
  }

  /**
   * Mod+S saves; over a file changed on disk the tab view asks first.
   * @param {EditorTab} tab
   * @param {KeyboardEvent} e
   */
  #onKeydown(tab, e) {
    if (!shortcuts.matches('save', e)) return;
    e.preventDefault();
    this.#emit(tab.changedOnDisk ? 'acp-tab-conflict' : 'acp-tab-save', { id: tab.id });
  }

  /**
   * @param {string} value The chosen item's.
   * @param {FooterTarget} target
   */
  #onFileMenuSelect(value, { path, folder }) {
    if (value === 'reveal') this.#emit('acp-file-reveal', { path: projects.projectPathOf(this.workspaces, path), expand: folder });
    else if (value === 'copy-path') this.#emit('acp-copy-path', { path });
    else if (value === 'copy-relative-path') this.#emit('acp-copy-path', { path: this.#pathOf(path) });
  }

  /**
   * @param {string} value The chosen entry's root-relative path.
   * @param {FolderList} list
   */
  #onFolderMenuSelect(value, list) {
    const entry = list.entries.find((e) => e.path === value);
    if (!entry) return;
    const path = projects.abs(this.root, entry.path);
    if (entry.isDir) this.#emit('acp-file-reveal', { path, expand: true });
    else this.#emit('acp-file-open', { path });
  }

  /**
   * Lists a crumb's folder and opens it under the crumb, the entry on the file's path selected.
   * @param {string} rel The file, root-relative.
   * @param {number} index The crumb's: `0` is the project's folder.
   * @param {HTMLElement} anchor
   */
  async #openFolderList(rel, index, anchor) {
    const rootId = this.rootId;
    if (rootId === null) return;
    const parts = rel.split('/');
    const folder = parts.slice(0, index).join('/');
    const selected = parts.slice(0, index + 1).join('/');
    const listing = ++this.#folderListing;
    const entries = await this.listDir(rootId, folder);
    if (listing !== this.#folderListing || rootId !== this.rootId) return;
    this.#folderMenu.openFrom({ folder, selected, entries }, anchor);
  }

  /** @param {string} path Absolute. */
  #pathOf(path) {
    return projects.shownPath(this.root, this.workspaces, path);
  }

  /**
   * The root-relative path of a file in the project's snapshot, whose folders the footer's crumbs list;
   * `null` for a worktree session's file or one outside the project.
   * @param {string} path Absolute.
   */
  #listedRel(path) {
    return projects.worktreeOf(this.workspaces, path) ? null : projects.rel(this.root, path);
  }

  /**
   * A file's path as its footer shows it: a project file's leads with the project's folder.
   * @param {string} path Absolute.
   */
  #footerPath(path) {
    const rel = this.#listedRel(path);
    return rel !== null && this.root ? `${projects.basename(this.root)}/${rel}` : this.#pathOf(path);
  }

  #onStatusPress = (/** @type {Event} */ e) => {
    this.#statusAnchor =
      e.composedPath().find(/** @returns {n is HTMLButtonElement} */ (n) => n instanceof HTMLButtonElement) ?? null;
  };

  /**
   * The footer's file, folder and language items open their menus; it handles the rest itself.
   * @param {EditorTab} tab
   * @param {Event} e
   */
  #onStatusClick(tab, e) {
    const { item, index } = /** @type {CustomEvent<{ item: string, index?: number }>} */ (e).detail;
    const anchor = this.#statusAnchor ?? /** @type {HTMLElement} */ (e.currentTarget);
    this.#statusAnchor = null;
    if (item === 'language') {
      this.#languageMenu.openFrom(tab, anchor);
    } else if (item === 'file') {
      this.#fileMenu.openFrom({ path: tab.path, folder: false }, anchor);
    } else if (item === 'path' && index !== undefined) {
      const rel = this.#listedRel(tab.path);
      if (rel !== null && this.rootId !== null) {
        this.#openFolderList(rel, index, anchor);
        return;
      }
      // The footer's crumbs are the folders of `#pathOf()`; crumb `index` is that many folders down.
      const folders = this.#pathOf(tab.path).split('/').filter(Boolean).length - 1;
      const path = tab.path.split('/').slice(0, index - folders).join('/');
      this.#fileMenu.openFrom({ path, folder: true }, anchor);
    }
  }

  /** The footer's menu of its file or of a folder on its path. */
  #renderFileMenu() {
    const target = this.#fileMenu.target;
    return html`<md-menu
      class="acp-code-view__file-menu acp-code-view__menu"
      aria-label=${target ? projects.basename(target.path) : 'File'}
      @select=${this.#fileMenu.onSelect}
      @closed=${this.#fileMenu.onClosed}
    >
      <md-menu-item class="acp-code-view__menu-item" value="reveal">Reveal in Files</md-menu-item>
      <md-hr></md-hr>
      <md-menu-item class="acp-code-view__menu-item" value="copy-path">Copy Path</md-menu-item>
      <md-menu-item class="acp-code-view__menu-item" value="copy-relative-path">Copy Relative Path</md-menu-item>
    </md-menu>`;
  }

  /** A footer crumb's folder: its folders, then its files; picking one opens or reveals it. */
  #renderFolderMenu() {
    const list = this.#folderMenu.target;
    return html`<md-menu
      class="acp-code-view__folder-menu acp-code-view__menu"
      aria-label=${list ? projects.basename(projects.abs(this.root, list.folder)) : 'Folder'}
      focus-on-open="selected"
      @select=${this.#folderMenu.onSelect}
      @closed=${this.#folderMenu.onClosed}
    >
      ${(list?.entries ?? []).map(
        (e) => html`<md-menu-item
          class=${classMap({ 'acp-code-view__menu-item': true, 'acp-code-view__menu-item_ignored': e.ignored })}
          value=${e.path}
          ?selected=${e.path === list?.selected}
        >
          <acp-file-icon slot="leading" class="acp-code-view__entry-icon" name=${e.name} ?folder=${e.isDir}></acp-file-icon>
          ${e.name}
        </md-menu-item>`,
      )}
    </md-menu>`;
  }

  /** The footer's language menu: highlight the file as another language, or by its extension again. */
  #renderLanguageMenu() {
    const shown = this.#languageMenu.target !== null;
    /**
     * @param {string} value
     * @param {string} label
     */
    const item = (value, label) =>
      html`<md-menu-item class="acp-code-view__menu-item" value=${value} ?selected=${value === this.language}>${label}</md-menu-item>`;
    return html`<md-menu
      class="acp-code-view__language-menu acp-code-view__menu"
      aria-label="Language"
      focus-on-open="selected"
      @select=${this.#languageMenu.onSelect}
      @closed=${this.#languageMenu.onClosed}
    >
      ${item('', 'Auto Detect')}
      <md-hr></md-hr>
      ${shown ? codeEditor.languages.map((name) => item(name, name)) : nothing}
    </md-menu>`;
  }

  render() {
    const tab = this.tab;
    if (!tab) return nothing;
    const editable = agents.isAgentsFile(tab.path);
    return html`${tab.deletedOnDisk
        ? html`<div class="acp-code-view__notice" role="status">
            Deleted on disk.${editable ? ' Save to create it again.' : ''}
          </div>`
        : nothing}<cdx-code-editor
        class="acp-code-view__editor"
        .readOnly=${!editable}
        .plugins=${codeEditor.plugins}
        filename=${tab.path}
        .language=${this.language}
        .value=${tab.draft ?? tab.content}
        .baseline=${tab.baseline}
        @click=${{ handleEvent: this.#onStatusPress, capture: true }}
        @cdx-status-click=${(/** @type {Event} */ e) => this.#onStatusClick(tab, e)}
        @cdx-change=${editable
          ? (/** @type {CustomEvent<{ value: string }>} */ e) => this.#emit('acp-tab-edit', { id: tab.id, value: e.detail.value })
          : nothing}
        @keydown=${editable ? (/** @type {KeyboardEvent} */ e) => this.#onKeydown(tab, e) : nothing}
      >
        <cdx-diff slot="diff" kind="baseline"></cdx-diff>
        <cdx-comments
          slot="comments"
          mode="single"
          .noResolve=${true}
          .author=${codeEditor.author}
          .comments=${this.#comments.threadsOf(tab.path)}
        ></cdx-comments>
        <cdx-footer slot="footer" path=${this.#footerPath(tab.path)}></cdx-footer>
      </cdx-code-editor>
      ${this.#renderFileMenu()} ${this.#renderFolderMenu()} ${this.#renderLanguageMenu()}
      ${this.#selectionActions.render()} ${this.#readOnlyHint.render()}`;
  }
}

customElements.define('acp-code-view', AcpCodeView);
