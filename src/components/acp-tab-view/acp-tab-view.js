import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/code-editor';
import '@symblight/wc-material/tabs';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import pushPinIcon from '@material-design-icons/svg/outlined/push_pin.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import differenceIcon from '@material-design-icons/svg/outlined/difference.svg?raw';
import settingsIcon from '@material-design-icons/svg/outlined/settings.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import { commentAuthor, editorLanguages, editorPlugins } from '../../models/editor-plugins.js';
import { EditorCommentsController } from '../../controllers/comments/EditorCommentsController.js';
import { SelectionActionsController } from '../../controllers/selection-actions/SelectionActionsController.js';
import { TabContentController } from '../../controllers/tab-content/TabContentController.js';
import { fileIconFor } from '../../models/file-icons.js';
import { fontStack } from '../../models/editor-fonts.js';
import '../acp-settings/acp-settings.js';
import '../acp-changes-review/acp-changes-review.js';
import '../acp-image-preview/acp-image-preview.js';
import '../acp-terminal/acp-terminal.js';
import '../acp-browser/acp-browser.js';
import '../acp-confirm-dialog/acp-confirm-dialog.js';
import { isAgentsFile } from '../../models/agents-file.js';
import { absPath, projectPathOf, relPath, worktreeOf } from '../../models/paths.js';
import { sessionOfTab } from '../../models/tab-ids.js';
import { lineHeightFor } from '../../models/settings.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { SortableController } from '../../controllers/sortable/SortableController.js';
import styles from './acp-tab-view.css?inline';

/** @typedef {import('../../models/types.js').EditorTab} EditorTab */
/** @typedef {import('../../models/types.js').AgentThread} AgentThread */
/** @typedef {import('../../models/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../models/types.js').Settings} Settings */
/** @typedef {import('../../models/types.js').FontFamily} FontFamily */
/** @typedef {import('../../models/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../models/types.js').FileDiff} FileDiff */
/** @typedef {import('../../models/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../models/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../acp-file-tree/acp-file-tree.js').ListDir} ListDir */
/** @typedef {import('../../controllers/session-changes/SessionChangesController.js').SessionChangesView} SessionChangesView */

/**
 * What the Changes tab shows.
 * @typedef {Object} ChangesReviewData
 * @property {GitChangesView} changes
 * @property {GitRepoView} repo
 * @property {ReadonlySet<string>} selection Files picked for the next commit.
 * @property {ReadonlySet<string>} expanded
 * @property {ReadonlyMap<string, FileDiff>} diffs
 */

/** @typedef {'tab' | 'others' | 'right' | 'all'} CloseScope */

/**
 * What the footer's file menu is open for: a tab's file, or a folder on its path.
 * @typedef {Object} FooterTarget
 * @property {EditorTab} tab
 * @property {string} path Absolute: the file, or the folder.
 * @property {boolean} folder
 */

/**
 * A project folder a footer crumb lists, like the IDE's breadcrumbs.
 * @typedef {Object} FolderList
 * @property {string} folder Root-relative; `''` for the root.
 * @property {string} selected Root-relative: the entry on the file's path.
 * @property {WorkspaceEntry[]} entries
 */

const RETURN_DELAY_MS = 2000;

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * @tag acp-tab-view
 * @summary The main column's tabs: files in the view their kind needs, and views; agents.json files are editable (Mod+S saves).
 * @fires acp-tab-activate `{ id }`
 * @fires acp-tab-close `{ id, scope }` A `CloseScope` around the tab, unsaved edits already confirmed.
 * @fires acp-tab-pin `{ id, pinned }`
 * @fires acp-tab-move `{ id, index }`
 * @fires acp-tab-edit `{ id, value }` An edit in an editable file.
 * @fires acp-tab-save `{ id, force? }` `force`: write over the file although it changed on disk (asked first).
 * @fires acp-tab-reload `{ id }` Drop the tab's edits for the file on disk (asked first).
 * @fires acp-copy-path `{ path }`
 * @fires acp-tab-language `{ path, language }` A language picked in a file's footer; `''` for its extension's.
 * @fires acp-file-reveal `{ path, expand }` Reveal in Files, or a folder picked in a footer crumb's list.
 * @fires acp-file-open `{ path }` A file picked in a footer crumb's list.
 */
export class AcpTabView extends LitElement {
  static properties = {
    tabs: { attribute: false },
    active: { attribute: false },
    pinned: { attribute: false },
    root: { attribute: false },
    worktrees: { attribute: false },
    editorFont: { attribute: false },
    editorFontSize: { attribute: false },
    comments: { attribute: false },
    commentFocus: { attribute: false },
    settings: { attribute: false },
    fonts: { attribute: false },
    agents: { attribute: false },
    settingsReveal: { attribute: false },
    review: { attribute: false },
    sessionReview: { attribute: false },
    languages: { attribute: false },
    rootId: { attribute: false },
    listDir: { attribute: false },
  };

  static styles = styles;

  /** @type {{ id: string, line: number } | null} Line to reveal in a tab once it is active and loaded (1-based). */
  #pendingLine = null;
  /** Set when the active tab changes; `updated()` scrolls it into view. */
  #activeChanged = false;
  #comments = new EditorCommentsController(this, {
    pathOf: (file) => file,
    comments: () => this.comments,
    focus: () => this.commentFocus,
  });
  #selectionActions = new SelectionActionsController(this, { pathOf: (file) => file });
  /** @type {TabContentController<EditorTab>} */
  #content = new TabContentController({
    views: {
      code: (tab) => this.#renderFile(tab, () => this.#renderCode(tab)),
      // The editor until the rendered preview exists: it keeps the diff gutter, comments and selection actions.
      markdown: (tab) => this.#renderFile(tab, () => this.#renderCode(tab)),
      image: (tab) =>
        this.#renderFile(
          tab,
          () => html`<acp-image-preview class="acp-tab-view__view" path=${tab.path} .image=${tab.image}></acp-image-preview>`,
        ),
      settings: () =>
        html`<acp-settings
          class="acp-tab-view__view"
          .settings=${this.settings}
          .fonts=${this.fonts}
          .agents=${this.agents}
          .reveal=${this.settingsReveal}
        ></acp-settings>`,
      changes: () => this.#renderChanges(),
      'session-changes': (tab) => this.#renderSessionChanges(tab),
      terminal: () => html`<acp-terminal class="acp-tab-view__view"></acp-terminal>`,
      browser: () => html`<acp-browser class="acp-tab-view__view"></acp-browser>`,
    },
  });
  /** @type {ContextMenuController<EditorTab>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-tab-view__menu'),
    onSelect: (value, tab) => this.#onMenuSelect(value, tab),
  });
  /** @type {ContextMenuController<FooterTarget>} */
  #fileMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-tab-view__file-menu'),
    onSelect: (value, target) => this.#onFileMenuSelect(value, target),
  });
  /** @type {ContextMenuController<FolderList>} */
  #folderMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-tab-view__folder-menu'),
    onSelect: (value, list) => this.#onFolderMenuSelect(value, list),
  });
  /** Counts crumb clicks, so a listing that comes back after a newer click is dropped. */
  #folderListing = 0;
  /** @type {ContextMenuController<EditorTab>} */
  #languageMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-tab-view__language-menu'),
    onSelect: (language, tab) => this.#emit('acp-tab-language', { path: tab.path, language }),
  });
  /**
   * The footer button pressed last. `cdx-status-click` doesn't say which, and the footer's menus open
   * under it; a capture listener sees the click before the button turns it into that event.
   * @type {HTMLElement | null}
   */
  #statusAnchor = null;
  /** Tabs are dragged within their group: pinned among pinned, the others among the others. */
  #sortable = new SortableController(this, {
    selector: '.acp-tab-view__tab',
    getId: (element) => element.getAttribute('value'),
    axis: 'horizontal',
    container: '.acp-tab-view__tab-strip',
    group: (id) => (this.#isPinned(id) ? 'pinned' : 'tabs'),
    onReorder: (id, index) => this.#emit('acp-tab-move', { id, index }),
  });
  /** A plain mouse wheel only scrolls vertically; turn that into scrolling the tab strip. */
  #onStripWheel = (/** @type {WheelEvent} */ e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const strip = /** @type {HTMLElement} */ (e.currentTarget);
    if (strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  };

  /** @type {ReturnType<typeof setTimeout> | undefined} Brings the active tab back after the strip was scrolled away and left alone. */
  #returnTimer;
  /** Counts down only while the strip is not hovered. */
  #scheduleReturn = () => {
    clearTimeout(this.#returnTimer);
    this.#returnTimer = setTimeout(() => {
      const strip = this.renderRoot.querySelector('.acp-tab-view__tab-strip');
      if (strip?.matches(':hover') ||this.#sortable.dragging !== null) return;
      this.#revealActiveTab('instant');
    }, RETURN_DELAY_MS);
  };
  #pauseReturn = () => clearTimeout(this.#returnTimer);

  constructor() {
    super();
    /** @type {readonly EditorTab[]} In strip order. */
    this.tabs = [];
    /** @type {string | null} The active tab's id. */
    this.active = null;
    /** @type {readonly string[]} Pinned tabs' ids. */
    this.pinned = [];
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {readonly WorktreeFolder[]} Worktree sessions' folders, whose files are marked. */
    this.worktrees = [];
    /** @type {string | null} The code editor's font family; `null` for its default. */
    this.editorFont = null;
    /** @type {number} px */
    this.editorFontSize = 13;
    /** @type {Readonly<Record<string, readonly AgentThread[]>>} Every file's comments, by absolute path. */
    this.comments = {};
    /** @type {CommentFocus | null} */
    this.commentFocus = null;
    /** @type {Settings | null} For the Settings tab. */
    this.settings = null;
    /** @type {FontFamily[] | null} For the Settings tab. */
    this.fonts = null;
    /** @type {import('../../models/types.js').AgentList | null} For the Settings tab. */
    this.agents = null;
    /** @type {import('../../models/types.js').SettingsReveal | null} For the Settings tab. */
    this.settingsReveal = null;
    /** @type {ChangesReviewData | null} For the Changes tab. */
    this.review = null;
    /** @type {SessionChangesView | null} For the active worktree session's Changes tab. */
    this.sessionReview = null;
    /** @type {Readonly<Record<string, string>>} Languages picked for files, by absolute path. */
    this.languages = {};
    /** @type {string | null} The project's snapshot id, for `listDir`; `null` while none is open. */
    this.rootId = null;
    /** @type {ListDir} Lists a project folder for a footer crumb. */
    this.listDir = async () => [];
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Puts the caret on a line of a tab once it is active and loaded.
   * @param {string} id
   * @param {number} line 1-based.
   */
  revealLine(id, line) {
    this.#pendingLine = { id, line };
    this.requestUpdate();
  }

  /**
   * Scrolls the Changes tab to a changed file; the tab must be open.
   * @param {string} path Absolute.
   */
  async revealChange(path) {
    await this.updateComplete;
    const rel = relPath(this.root, path);
    if (rel !== null) this.renderRoot.querySelector('acp-changes-review')?.scrollToChange(rel);
  }

  /**
   * Closes tabs around one after confirming unsaved edits.
   * @param {string} id
   * @param {CloseScope} scope
   * @param {string[]} ids The tabs it closes.
   */
  async #close(id, scope, ids) {
    if (!(await this.#confirmDiscard(ids))) return;
    if (this.active !== null && ids.includes(this.active)) this.#pendingLine = null;
    this.#emit('acp-tab-close', { id, scope });
  }

  /**
   * Asks before closing tabs with unsaved edits; `true` when there are none, or the user discards them.
   * @param {string[]} ids Tabs about to close.
   */
  async #confirmDiscard(ids) {
    const dirty = this.tabs.filter((t) => ids.includes(t.id) && t.draft !== null);
    if (!dirty.length) return true;
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('acp-confirm-dialog')
    );
    return dialog.confirm({
      headline: 'Discard unsaved changes?',
      message: dirty.map((t) => basename(t.path)).join(', ') + (dirty.length > 1 ? ' have' : ' has') + ' unsaved changes.',
      detail: 'Press ⌘S / Ctrl+S in the editor to save.',
      confirmLabel: 'Discard',
      destructive: true,
    });
  }

  /**
   * Mod+S in an editable file's editor saves it.
   * @param {string} id
   * @param {KeyboardEvent} e
   */
  #onEditorKeydown(id, e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    if (this.tabs.find((t) => t.id === id)?.changedOnDisk) this.confirmOverwrite(id);
    else this.#emit('acp-tab-save', { id });
  }

  /**
   * Asks whether to save an edited tab over its file, which changed on disk, or reload the file;
   * the container calls it when it finds the change only as it saves.
   * @param {string} id
   */
  async confirmOverwrite(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('acp-confirm-dialog')
    );
    const choice = await dialog.choose({
      headline: `${basename(tab.path)} changed on disk`,
      message: 'It was changed since you started editing it, by an agent or another program.',
      detail: 'Overwrite replaces that change with your edits; Reload drops your edits.',
      confirmLabel: 'Overwrite',
      extraLabel: 'Reload',
      destructive: true,
    });
    if (choice === 'confirm') this.#emit('acp-tab-save', { id, force: true });
    else if (choice === 'extra') this.#emit('acp-tab-reload', { id });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#returnTimer);
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('active')) this.#activeChanged = true;
  }

  updated() {
    const pending = this.#pendingLine;
    if (pending !== null && pending.id === this.active && this.tabs.find((t) => t.id === pending.id)?.loaded) {
      this.#revealPendingLine();
    }
    if (!this.#activeChanged) return;
    this.#activeChanged = false;
    this.#revealActiveTab();
  }

  /** Puts the caret on `#pendingLine` in the active tab's editor, once. */
  async #revealPendingLine() {
    const pending = this.#pendingLine;
    if (pending === null) return;
    this.#pendingLine = null;
    await this.updateComplete;
    const editor = this.renderRoot
      .querySelector('.acp-tab-view__panel[active]')
      ?.querySelector('cdx-code-editor');
    if (!editor) return;
    await editor.updateComplete;
    editor.navigation.goToLine(pending.line);
    editor.focus();
  }

  /**
   * Scrolls the tab strip so the active tab is fully visible.
   * @param {ScrollBehavior} [behavior] Defaults to the strip's own (smooth).
   */
  async #revealActiveTab(behavior = 'auto') {
    const tab = [...this.renderRoot.querySelectorAll('md-tab')].find((t) => t.getAttribute('value') === this.active);
    // The tab lays out after it upgrades; scroll once it has.
    await tab?.updateComplete;
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  }

  /** @param {Event} e */
  #onTabChange(e) {
    this.#pendingLine = null;
    this.#emit('acp-tab-activate', { id: /** @type {CustomEvent<{ value: string }>} */ (e).detail.value });
  }

  /**
   * The tab's button: closes it, or unpins it when pinned.
   * @param {Event} e
   * @param {string} id
   */
  #onCloseClick(e, id) {
    e.stopPropagation(); // don't let the tab activate itself
    if (this.#isPinned(id)) this.#emit('acp-tab-pin', { id, pinned: false });
    else this.#close(id, 'tab', [id]);
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} id
   */
  #onCloseKey(e, id) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.#onCloseClick(e, id);
  }

  /**
   * @param {string} value The chosen item's.
   * @param {EditorTab} tab The tab the menu was opened on.
   */
  #onMenuSelect(value, tab) {
    const paths = this.tabs.map((t) => t.id);
    const closable = paths.filter((id) => !this.#isPinned(id));
    const index = paths.indexOf(tab.id);
    if (value === 'close') this.#close(tab.id, 'tab', [tab.id]);
    else if (value === 'close-others') this.#close(tab.id, 'others', closable.filter((id) => id !== tab.id));
    else if (value === 'close-right') this.#close(tab.id, 'right', closable.filter((id) => paths.indexOf(id) > index));
    else if (value === 'close-all') this.#close(tab.id, 'all', closable);
    else if (value === 'pin' || value === 'unpin') this.#emit('acp-tab-pin', { id: tab.id, pinned: value === 'pin' });
    else if (value === 'copy-path') this.#emit('acp-copy-path', { path: tab.path });
  }

  /**
   * @param {string} value The chosen item's.
   * @param {FooterTarget} target
   */
  #onFileMenuSelect(value, { path, folder }) {
    if (value === 'reveal') this.#emit('acp-file-reveal', { path: projectPathOf(this.worktrees, path), expand: folder });
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
    const path = absPath(this.root, entry.path);
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

  /**
   * The root-relative path of a file in the project's snapshot, whose folders the footer's crumbs list;
   * `null` for a worktree session's file or one outside the project.
   * @param {string} path Absolute.
   */
  #listedRel(path) {
    return worktreeOf(this.worktrees, path) ? null : relPath(this.root, path);
  }

  /**
   * A file's path as its footer shows it: a project file's leads with the project's folder.
   * @param {string} path Absolute.
   */
  #footerPath(path) {
    const rel = this.#listedRel(path);
    return rel !== null && this.root ? `${basename(this.root)}/${rel}` : this.#pathOf(path);
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
      this.#fileMenu.openFrom({ tab, path: tab.path, folder: false }, anchor);
    } else if (item === 'path' && index !== undefined) {
      const rel = this.#listedRel(tab.path);
      if (rel !== null && this.rootId !== null) {
        this.#openFolderList(rel, index, anchor);
        return;
      }
      // The footer's crumbs are the folders of `#pathOf()`; crumb `index` is that many folders down.
      const folders = this.#pathOf(tab.path).split('/').filter(Boolean).length - 1;
      const path = tab.path.split('/').slice(0, index - folders).join('/');
      this.#fileMenu.openFrom({ tab, path, folder: true }, anchor);
    }
  }

  /** @param {string} id */
  #isPinned(id) {
    return this.pinned.includes(id);
  }

  /**
   * Title, icon and tooltip of a tab.
   * @param {EditorTab} tab
   * @returns {{ title: string, icon: string, tooltip: string }}
   */
  #describe(tab) {
    if (tab.kind === 'settings') return { title: 'Settings', icon: settingsIcon, tooltip: 'Settings' };
    if (tab.kind === 'changes') {
      return { title: 'Changes', icon: differenceIcon, tooltip: 'Changed files and their diffs against HEAD' };
    }
    if (tab.kind === 'session-changes') {
      const worktree = this.worktrees.find((w) => w.sessionId === sessionOfTab(tab.id));
      const branch = worktree?.branch ?? 'its worktree';
      return { title: worktree?.title ?? 'Changes', icon: differenceIcon, tooltip: `Changes on ${branch} since the session started` };
    }
    if (tab.kind === 'terminal') return { title: 'Terminal', icon: terminalIcon, tooltip: 'Terminal' };
    if (tab.kind === 'browser') return { title: 'Browser', icon: languageIcon, tooltip: 'Browser' };
    const name = basename(tab.path);
    const worktree = worktreeOf(this.worktrees, tab.path);
    if (worktree) {
      return { title: name, icon: branchIcon, tooltip: `${this.#pathOf(tab.path)} in worktree ${worktree.branch}` };
    }
    return { title: name, icon: fileIconFor(name) ?? fileIcon, tooltip: this.#pathOf(tab.path) };
  }

  /**
   * A file's path as the footer shows it: relative to the project, or to its worktree session's folder.
   * @param {string} path Absolute.
   */
  #pathOf(path) {
    const worktree = worktreeOf(this.worktrees, path);
    return relPath(worktree ? worktree.folder : this.root, path) ?? path;
  }

  /** @param {EditorTab} tab */
  #renderTab(tab) {
    const { title, icon, tooltip } = this.#describe(tab);
    const pinned = this.#isPinned(tab.id);
    const id = `tab-${tab.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    const dragging = this.#sortable.dragging;
    return html`<md-tab
      id=${id}
      class=${classMap({
        'acp-tab-view__tab': true,
        'acp-tab-view__tab_sorting': dragging !== null,
        'acp-tab-view__tab_dragging': dragging === tab.id,
      })}
      style=${styleMap({ '--_acp-tab-view-shift': `${this.#sortable.offsetOf(tab.id)}px` })}
      value=${tab.id}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#menu.onContextMenu(tab, e)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#menu.onKeydown(tab, e)}
    >
      <md-tooltip class="acp-tab-view__tooltip" for=${id} placement="bottom" show-delay="800">${tooltip}</md-tooltip>
      <span class="acp-tab-view__tab-label">
        <md-icon class="acp-tab-view__file-icon">${unsafeSVG(icon)}</md-icon>
        ${title}
        ${tab.draft !== null ? html`<span class="acp-tab-view__unsaved" title="Unsaved changes">●</span>` : nothing}
        <span
          class="acp-tab-view__close"
          role="button"
          tabindex="0"
          aria-label="${pinned ? 'Unpin' : 'Close'} ${title}"
          title=${pinned ? 'Unpin' : 'Close'}
          @click=${(/** @type {Event} */ e) => this.#onCloseClick(e, tab.id)}
          @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onCloseKey(e, tab.id)}
          ><md-icon class="acp-tab-view__close-icon">${unsafeSVG(pinned ? pushPinIcon : closeIcon)}</md-icon></span
        >
      </span>
    </md-tab>`;
  }

  #renderMenu() {
    const tab = this.#menu.target;
    const paths = this.tabs.map((t) => t.id);
    const pins = this.pinned;
    const pinned = tab !== null && pins.includes(tab.id);
    // Only the actions that would do something: the close ones never close pinned tabs.
    const closable = paths.filter((id) => !pins.includes(id));
    const index = tab ? paths.indexOf(tab.id) : -1;
    /**
     * @param {boolean} shown
     * @param {string} value
     * @param {string} label
     */
    const item = (shown, value, label) =>
      shown ? html`<md-menu-item class="acp-tab-view__menu-item" value=${value}>${label}</md-menu-item>` : nothing;
    return html`<md-menu
      class="acp-tab-view__menu"
      aria-label=${tab ? this.#describe(tab).title : 'Tab'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
    >
      ${item(true, 'close', 'Close')}
      ${item(closable.some((id) => id !== tab?.id), 'close-others', 'Close Other Tabs')}
      ${item(closable.some((id) => paths.indexOf(id) > index), 'close-right', 'Close Tabs to the Right')}
      ${item(closable.length > 0, 'close-all', 'Close All Tabs')}
      <md-hr></md-hr>
      ${item(true, pinned ? 'unpin' : 'pin', pinned ? 'Unpin Tab' : 'Pin Tab')}
      ${item(tab?.kind === 'file', 'copy-path', 'Copy Path')}
    </md-menu>`;
  }

  /** The footer's menu of its file or of a folder on its path. */
  #renderFileMenu() {
    const target = this.#fileMenu.target;
    return html`<md-menu
      class="acp-tab-view__file-menu acp-tab-view__footer-menu"
      aria-label=${target ? basename(target.path) : 'File'}
      @select=${this.#fileMenu.onSelect}
      @closed=${this.#fileMenu.onClosed}
    >
      <md-menu-item class="acp-tab-view__menu-item acp-tab-view__menu-item_compact" value="reveal">Reveal in Files</md-menu-item>
      <md-hr></md-hr>
      <md-menu-item class="acp-tab-view__menu-item acp-tab-view__menu-item_compact" value="copy-path">Copy Path</md-menu-item>
      <md-menu-item class="acp-tab-view__menu-item acp-tab-view__menu-item_compact" value="copy-relative-path">Copy Relative Path</md-menu-item>
    </md-menu>`;
  }

  /** A footer crumb's folder: its folders, then its files; picking one opens or reveals it. */
  #renderFolderMenu() {
    const list = this.#folderMenu.target;
    return html`<md-menu
      class="acp-tab-view__folder-menu acp-tab-view__footer-menu"
      aria-label=${list ? basename(absPath(this.root, list.folder)) : 'Folder'}
      focus-on-open="selected"
      @select=${this.#folderMenu.onSelect}
      @closed=${this.#folderMenu.onClosed}
    >
      ${(list?.entries ?? []).map(
        (e) => html`<md-menu-item
          class=${classMap({
            'acp-tab-view__menu-item': true,
            'acp-tab-view__menu-item_compact': true,
            'acp-tab-view__menu-item_ignored': e.ignored,
          })}
          value=${e.path}
          ?selected=${e.path === list?.selected}
        >
          <md-icon slot="leading" class="acp-tab-view__entry-icon"
            >${unsafeSVG(e.isDir ? folderIcon : (fileIconFor(e.name) ?? fileIcon))}</md-icon
          >
          ${e.name}
        </md-menu-item>`,
      )}
    </md-menu>`;
  }

  /** The footer's language menu: highlight the file as another language, or by its extension again. */
  #renderLanguageMenu() {
    const tab = this.#languageMenu.target;
    const picked = tab ? (this.languages[tab.path] ?? '') : '';
    /**
     * @param {string} value
     * @param {string} label
     */
    const item = (value, label) =>
      html`<md-menu-item class="acp-tab-view__menu-item acp-tab-view__menu-item_compact" value=${value} ?selected=${value === picked}>${label}</md-menu-item>`;
    return html`<md-menu
      class="acp-tab-view__language-menu acp-tab-view__footer-menu"
      aria-label="Language"
      focus-on-open="selected"
      @select=${this.#languageMenu.onSelect}
      @closed=${this.#languageMenu.onClosed}
    >
      ${item('', 'Auto Detect')}
      <md-hr></md-hr>
      ${tab ? editorLanguages.map((name) => item(name, name)) : nothing}
    </md-menu>`;
  }

  /** Font settings for file tabs only; views keep the library defaults. */
  #editorStyle() {
    const font = this.editorFont;
    const size = this.editorFontSize;
    return styleMap({
      '--cdx-code-editor-mono-font-family': font ? fontStack(font) : null,
      '--cdx-code-editor-code-font-size': `${size}px`,
      '--cdx-code-editor-code-line-height': `${lineHeightFor(size)}px`,
    });
  }

  /**
   * A file in its view, or the read error in place of it.
   * @param {EditorTab} tab
   * @param {() => unknown} view
   */
  #renderFile(tab, view) {
    return tab.error ? html`<pre class="acp-tab-view__error">${tab.error}</pre>` : view();
  }

  /** @param {EditorTab} tab */
  #renderCode(tab) {
    const editable = isAgentsFile(tab.path);
    return html`<cdx-code-editor
        class="acp-tab-view__editor"
        style=${this.#editorStyle()}
        .readOnly=${!editable}
        .plugins=${editorPlugins}
        filename=${tab.path}
        .language=${this.languages[tab.path] ?? ''}
        .value=${tab.draft ?? tab.content}
        .baseline=${tab.baseline}
        @click=${{ handleEvent: this.#onStatusPress, capture: true }}
        @cdx-status-click=${(/** @type {Event} */ e) => this.#onStatusClick(tab, e)}
        @cdx-change=${editable
          ? (/** @type {CustomEvent<{ value: string }>} */ e) => this.#emit('acp-tab-edit', { id: tab.id, value: e.detail.value })
          : nothing}
        @keydown=${editable ? (/** @type {KeyboardEvent} */ e) => this.#onEditorKeydown(tab.id, e) : nothing}
      >
        <cdx-diff slot="diff" kind="baseline"></cdx-diff>
        <cdx-comments
          slot="comments"
          mode="single"
          .noResolve=${true}
          .author=${commentAuthor}
          .comments=${this.#comments.threadsOf(tab.path)}
        ></cdx-comments>
        <cdx-footer slot="footer" path=${this.#footerPath(tab.path)}></cdx-footer>
      </cdx-code-editor>`;
  }

  #renderChanges() {
    const review = this.review;
    if (!review) return nothing;
    return html`<acp-changes-review
      class="acp-tab-view__view"
      .changes=${review.changes}
      .repo=${review.repo}
      .selection=${review.selection}
      .expanded=${review.expanded}
      .diffs=${review.diffs}
      .root=${this.root}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
    ></acp-changes-review>`;
  }

  /** @param {EditorTab} tab */
  #renderSessionChanges(tab) {
    const review = this.sessionReview;
    if (!review || review.sessionId !== sessionOfTab(tab.id)) return nothing;
    return html`<acp-changes-review
      class="acp-tab-view__view"
      .changes=${review.changes}
      .expanded=${review.expanded}
      .diffs=${review.diffs}
      .root=${review.folder}
      .base=${review.base}
      .branch=${review.branch}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
    ></acp-changes-review>`;
  }

  /** @param {EditorTab} tab */
  #renderPanel(tab) {
    return html`<md-tab-panel class="acp-tab-view__panel" value=${tab.id} ?active=${tab.id === this.active}>
      ${this.#content.render(tab)}
    </md-tab-panel>`;
  }

  render() {
    return html`
      <div class="acp-tab-view__tab-strip" @wheel=${this.#onStripWheel} 
        @pointerenter=${this.#pauseReturn}
        @pointerleave=${this.#scheduleReturn}
      >
        <md-tabs class="acp-tab-view__tabs" variant="secondary" .value=${this.active ?? ''} @change=${this.#onTabChange}>
          ${repeat(this.tabs, (t) => t.id, (t) => this.#renderTab(t))}
        </md-tabs>
      </div>
      ${repeat(this.tabs, (t) => t.id, (t) => this.#renderPanel(t))}
      ${this.#renderMenu()} ${this.#renderFileMenu()} ${this.#renderFolderMenu()}
      ${this.#renderLanguageMenu()}
      ${this.#selectionActions.render()}
      <acp-confirm-dialog></acp-confirm-dialog>
    `;
  }
}

customElements.define('acp-tab-view', AcpTabView);
