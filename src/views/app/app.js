import { app } from '../../hooks/app/app.js';
import { html, nothing } from 'lit';
import { agentConfig } from '../../services/agent-config/agent-config.js';
import { sessionController } from '../../services/session-controller/session-controller.js';
import { projectController } from '../../services/project-controller/project-controller.js';
import { sessionRootController } from '../../services/session-root-controller/session-root-controller.js';
import { gitController } from '../../services/git-controller/git-controller.js';
import { trustController } from '../../services/trust-controller/trust-controller.js';
import { terminalController } from '../../services/terminals/terminals.js';
import { onMenuAction, quickOpen, revealPath } from '../../services/ipc/ipc.js';
import { $about } from '../../stores/about/about.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $columnWidths, $hiddenColumns, showColumn, toggleColumn } from '../../stores/layout/layout.js';
import { $notices, dismissNotice, holdNotices, runNoticeAction } from '../../stores/notices/notices.js';
import { $projectSearch, $searchDialogPrefs, addRecentSearch, saveProjectSearch, setSearchDialogPrefs } from '../../stores/search/search.js';
import { $treeRoot } from '../../stores/session-root/session-root.js';
import { $worktrees } from '../../stores/sessions/sessions.js';
import { $trustPrompt } from '../../stores/trust/trust.js';
import { $rootId, $workspace } from '../../stores/workspace/workspace.js';
import { projectPathOf, relPath } from '../../models/paths/paths.js';
import { trustConfirm } from '../../models/trust/trust.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import '../../components/about-dialog/about-dialog.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/toolbar/toolbar.js';
import '../session-column/session-column.js';
import '../agent-column/agent-column.js';
import '../main-column/main-column.js';
import '../file-column/file-column.js';
import '../../components/nav-rail/nav-rail.js';
import '../../components/quick-open/quick-open.js';
import '../../components/search-dialog/search-dialog.js';
import '../../components/resize-handle/resize-handle.js';
import '../../components/snackbars/snackbars.js';
import { ColumnResizeController } from '../../controllers/resize/ColumnResizeController.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/pane/pane.js';
import '../../components/split/split.js';

/** @typedef {import('../file-column/file-column.js').SideView} SideView */
/** @typedef {import('../../models/types/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types/types.js').TrustPrompt} TrustPrompt */
/** @typedef {import('../../models/types/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../models/types/types.js').SearchDialogPrefs} SearchDialogPrefs */
/** @typedef {import('../../models/types/types.js').SearchOptions} SearchOptions */

/** @type {SearchDialogState} A project's search before its first one. */
const NO_SEARCH = { query: '', caseSensitive: false, wholeWord: false, regex: false, folder: '', mask: '' };

/*
 * How the panes share the row. Session and file columns shrink, down to their resize minimums, to
 * fit the main column's minimum only once the agent column (its far larger shrink factor) is at its
 * own; a drag starts from the rendered width.
 */
const SESSION_PANE =
  '--acp-pane-flex: 0 1 var(--acp-session-column-width); --acp-pane-width: var(--acp-session-column-width); --acp-pane-min-width: var(--acp-session-column-min-width); --acp-pane-max-width: var(--acp-column-max-width)';
const AGENT_PANE =
  '--acp-pane-flex: 0 1000 var(--acp-agent-column-width); --acp-pane-width: var(--acp-agent-column-width); --acp-pane-min-width: var(--acp-agent-column-min-width)';
const AGENT_FILL_PANE = '--acp-pane-flex: 1';
const MAIN_PANE = '--acp-pane-min-width: var(--acp-main-column-min-width)';
const FILES_PANE =
  '--acp-pane-flex: 0 1 var(--acp-file-tree-width); --acp-pane-width: var(--acp-file-tree-width); --acp-pane-min-width: var(--acp-file-tree-min-width); --acp-pane-max-width: var(--acp-column-max-width)';

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor/file columns, Quick Open, the search dialog, About, the project trust dialog, snackbars, global shortcuts and menu bar items.
 */
export class AcpApp extends ViewElement {
  static properties = {
    sideView: { state: true },
    quickOpenFiles: { state: true },
    searchFolders: { state: true },
    searchFoldersQuery: { state: true },
  };

  #resize = new ColumnResizeController(this, {
    store: $columnWidths,
    columns: {
      session: { property: '--acp-session-column-width', min: 180, max: 524, partner: 'agent' },
      agent: { property: '--acp-agent-column-width', min: 280, max: 1600 },
      side: { property: '--acp-file-tree-width', min: 200, max: 524 },
    },
  });
  #activePath = new StoreController(this, { store: $activePath });
  #hiddenColumns = new StoreController(this, { store: $hiddenColumns });
  #workspace = new StoreController(this, { store: $workspace });
  #rootId = new StoreController(this, { store: $rootId });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #notices = new StoreController(this, { store: $notices });
  #about = new StoreController(this, { store: $about });
  #trustPrompt = new StoreController(this, { store: $trustPrompt, onChange: (prompt) => this.#askTrust(prompt) });
  #searchPrefs = new StoreController(this, { store: $searchDialogPrefs });
  #projectSearch = new StoreController(this, { store: $projectSearch });
  #search = new FindInFilesController(this, { slot: 'dialog' });
  /** Sequence of folder menu queries; only the latest answer is shown. */
  #foldersRequest = 0;
  /** Sequence of Quick Open queries; only the latest answer is shown. */
  #quickOpenRequest = 0;
  /** @type {Promise<() => void> | null} */
  #menuListener = null;

  #onMenuAction = (/** @type {import('../../services/ipc/ipc.js').MenuAction} */ id) => {
    if (id === 'about') this.#showAbout();
    else if (id === 'new-terminal') this.#newTerminal();
    else this.#showSettings();
  };

  #newTerminal() {
    terminalController.newTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  #openProjectTerminal() {
    terminalController.projectTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  /**
   * Cmd/Ctrl+P: Quick Open. Cmd/Ctrl+Shift+F: the search dialog. Cmd/Ctrl+Shift+T: the session in chat /
   * terminal. Ctrl+`: New Terminal. While the search dialog is open, only Cmd/Ctrl+Shift+F.
   */
  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.#showSearchDialog();
      return;
    }
    if (this.#searchDialog?.open) return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
      e.preventDefault();
      this.#newTerminal();
      return;
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'p' && !e.shiftKey) {
      e.preventDefault();
      this.#showQuickOpen();
    } else if (key === 't' && e.shiftKey) {
      e.preventDefault();
      this.renderRoot.querySelector('acp-agent-column')?.toggleView();
    }
  };

  constructor() {
    super();
    /** @type {SideView} Mirrors the file column's view, for the rail's pressed button. */
    this.sideView = 'files';
    /** @type {QuickOpenItem[]} */
    this.quickOpenFiles = [];
    /** @type {QuickOpenItem[]} The search dialog's folder menu. */
    this.searchFolders = [];
    /** @type {string | null} The query `searchFolders` answers. */
    this.searchFoldersQuery = null;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKeydown);
    this.#menuListener = onMenuAction(this.#onMenuAction);
    this.#menuListener.catch((err) => app.log('warn', `menu bar not connected: ${err}`));
    agentConfig.start();
    trustController.start();
    sessionController.init().catch((err) => app.reportError('Loading sessions failed', err));
    gitController.start();
    terminalController.start();
    sessionRootController.start();
    projectController.restore().catch((err) => app.reportError('Reopening folder failed', err));
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.#onKeydown);
    this.#menuListener?.then((stop) => stop()).catch(() => {});
    this.#menuListener = null;
    super.disconnectedCallback();
  }

  /**
   * Shows the trust dialog for `prompt`, or closes it; an answer counts only while its prompt is current.
   * @param {TrustPrompt | null} prompt
   */
  async #askTrust(prompt) {
    await this.updateComplete;
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('.acp-app__trust')
    );
    if (prompt === null) {
      dialog.close();
      return;
    }
    const trusted = await dialog.confirm(trustConfirm(prompt));
    if ($trustPrompt.get() !== prompt) return;
    if (trusted) trustController.trust();
    else trustController.dismiss();
  }

  /** Rendered unconditionally, so present after the first render. */
  get #main() {
    return /** @type {HTMLElementTagNameMap['acp-main-column']} */ (
      this.renderRoot.querySelector('acp-main-column')
    );
  }

  /** Rendered unconditionally, so present after the first render. */
  get #files() {
    return /** @type {HTMLElementTagNameMap['acp-file-column']} */ (
      this.renderRoot.querySelector('acp-file-column')
    );
  }

  #showFiles() {
    this.sideView = 'files';
    showColumn('side');
    this.#files.showFiles();
  }

  #showSearch() {
    this.sideView = 'search';
    showColumn('side');
    this.#files.showSearch();
  }

  #showChanges() {
    this.sideView = 'changes';
    showColumn('side');
    this.#files.showChanges();
  }

  #showSettings() {
    this.#main.openSettings();
  }

  #showAbout() {
    app.loadAbout();
    /** @type {HTMLElementTagNameMap['acp-about-dialog']} */ (this.renderRoot.querySelector('acp-about-dialog')).show();
  }

  /** Opens Quick Open; `:` (Go to line) needs a file open in the editor. */
  #showQuickOpen() {
    const palette = /** @type {HTMLElementTagNameMap['acp-quick-open']} */ (
      this.renderRoot.querySelector('acp-quick-open')
    );
    palette.hasOpenFile = $activePath.get() !== null;
    palette.show();
  }

  /** @param {Event} e */
  async #onPaletteQuery(e) {
    const { query } = /** @type {CustomEvent<{ query: string | null }>} */ (e).detail;
    const id = ++this.#quickOpenRequest;
    const rootId = this.#rootId.value;
    if (query === null || rootId === null) {
      this.quickOpenFiles = [];
      return;
    }
    try {
      const result = await quickOpen(rootId, query);
      if (id !== this.#quickOpenRequest || result.cancelled) return;
      this.quickOpenFiles = result.items;
    } catch (err) {
      app.reportError('File search failed', err);
    }
  }

  /** @param {Event} e */
  #onPalettePick(e) {
    this.#main.openFile(projectController.absPath(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path));
  }

  /** @returns {HTMLElementTagNameMap['acp-search-dialog'] | null} */
  get #searchDialog() {
    return this.renderRoot?.querySelector('acp-search-dialog') ?? null;
  }

  /** The open project's last search and recent queries. */
  get #savedSearch() {
    const project = this.#workspace.value?.path;
    return project ? this.#projectSearch.value[project] : undefined;
  }

  /** Opens the search dialog with the project's last search, or the editor's selection; open, selects the query. */
  #showSearchDialog() {
    const { query, caseSensitive, wholeWord, regex, folder, mask } = this.#savedSearch ?? NO_SEARCH;
    this.#searchDialog?.show({ query, caseSensitive, wholeWord, regex, folder, mask }, this.#main.selectedText());
  }

  /** @param {Event} e */
  #onSearchQuery(e) {
    const { options, state, delay } = /** @type {CustomEvent<{ options: SearchOptions, state: SearchDialogState, delay: number }>} */ (e).detail;
    this.#search.setActive(true);
    this.#search.search(options, delay);
    const project = this.#workspace.value?.path;
    if (project) saveProjectSearch(project, state);
  }

  #onSearchClose() {
    this.#search.setActive(false);
  }

  /** @param {Event} e */
  async #onSearchFolders(e) {
    const { query } = /** @type {CustomEvent<{ query: string }>} */ (e).detail;
    const id = ++this.#foldersRequest;
    const rootId = this.#rootId.value;
    if (rootId === null) {
      this.searchFolders = [];
      this.searchFoldersQuery = query;
      return;
    }
    try {
      const result = await quickOpen(rootId, query, 'dirs');
      if (id !== this.#foldersRequest || result.cancelled) return;
      this.searchFolders = result.items;
      this.searchFoldersQuery = query;
    } catch (err) {
      app.reportError('Folder search failed', err);
    }
  }

  /**
   * A match from the dialog: its tab, with the match selected.
   * @param {Event} e
   */
  #onSearchOpen(e) {
    const { path, line, column, length, state } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number, state: SearchDialogState }>} */ (
      e
    ).detail;
    this.#recordSearch(state.query);
    this.#main.openFile(projectController.absPath(path), { line, column, length });
  }

  /**
   * "Open in panel": the side column's Search pane takes the dialog's search.
   * @param {Event} e
   */
  #onSearchPopout(e) {
    const { state } = /** @type {CustomEvent<{ state: SearchDialogState }>} */ (e).detail;
    this.#recordSearch(state.query);
    this.sideView = 'search';
    showColumn('side');
    this.#files.showSearch(state);
  }

  /** @param {string} query */
  #recordSearch(query) {
    const project = this.#workspace.value?.path;
    if (project) addRecentSearch(project, query);
  }

  /** @param {Event} e */
  #onSearchPrefs(e) {
    setSearchDialogPrefs(/** @type {CustomEvent<{ patch: Partial<SearchDialogPrefs> }>} */ (e).detail.patch);
  }

  /** @param {Event} e */
  #onColumnToggle(e) {
    toggleColumn(/** @type {CustomEvent<{ column: string }>} */ (e).detail.column);
  }

  /** @param {Event} e */
  #onRevealPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    revealPath(path).catch((err) => app.log('warn', `showing logs failed: ${err}`));
  }

  /** @param {Event} e */
  #onFileOpen(e) {
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line?: number, column?: number, length?: number }>} */ (
      e
    ).detail;
    // A search match comes with its range, selected in the tab.
    const at = line !== undefined && column !== undefined && length !== undefined ? { line, column, length } : line;
    this.#main.openFile(path, at);
  }

  /**
   * A file named in the chat: its tab, and its row in the file tree.
   * @param {Event} e
   */
  #onChatFileOpen(e) {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number | null }>} */ (e).detail;
    this.#main.openFile(path, line);
    this.#revealInTree(path);
  }

  /**
   * A folder named in the chat: only its row in the file tree, expanded to show what's in it.
   * @param {Event} e
   */
  #onChatFileReveal(e) {
    this.#revealInTree(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path, { expand: true });
  }

  /**
   * Reveal in Files, from an editor's footer: a file's row, or a folder's, expanded.
   * @param {Event} e
   */
  #onFileReveal(e) {
    const { path, expand } = /** @type {CustomEvent<{ path: string, expand: boolean }>} */ (e).detail;
    this.#revealInTree(path, { expand });
  }

  /**
   * @param {string} path Absolute; outside the project and its worktrees there's no row to show.
   * @param {{ expand?: boolean }} [options] Expand a folder itself too.
   */
  async #revealInTree(path, options) {
    // The tree lists a worktree's folder or the project; a path of the other is shown by its twin.
    const rel = relPath($treeRoot.get().path, path) ?? relPath(projectController.path, projectPathOf($worktrees.get(), path));
    if (rel === null) return;
    this.sideView = 'files';
    showColumn('side');
    await this.updateComplete;
    this.#files.reveal(rel, options);
  }

  /** @param {Event} e */
  #onDiffOpen(e) {
    this.#main.showChange(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path);
  }

  /** @param {Event} e */
  #onPaletteGoToLine(e) {
    this.#main.goToLine(/** @type {CustomEvent<{ line: number }>} */ (e).detail.line);
  }

  /**
   * Divider beside a column, resizing it.
   * @param {string} name Column id in `#resize`.
   * @param {string} label
   * @param {'start' | 'end'} [edge] Which edge of the column it sits on.
   */
  #renderResizer(name, label, edge = 'end') {
    const { value, min, max } = this.#resize.column(name);
    return html`<acp-resize-handle
      class="acp-split__handle"
      name=${name}
      edge=${edge}
      label=${label}
      .value=${value}
      .min=${min}
      .max=${max}
    ></acp-resize-handle>`;
  }

  render() {
    const hasCode = this.#activePath.value !== null;
    const hidden = this.#hiddenColumns.value;
    const sessionHidden = hidden.includes('session');
    const filesHidden = hidden.includes('side');
    // A hidden column drops its inline width, so its collapse can take it to nothing.
    // With no tabs beside it, the agent column takes the space.
    const agentFills = !hasCode;
    return html`<acp-panel variant="window">
      <acp-toolbar
        slot="header"
        .workspace=${this.#workspace.value}
        .git=${this.#gitRepo.value}
        .hiddenColumns=${hidden}
        @acp-column-toggle=${this.#onColumnToggle}
      ></acp-toolbar>
      <acp-split>
        <acp-pane
          edge="end"
          style=${sessionHidden ? SESSION_PANE : `${SESSION_PANE}; ${this.#resize.columnStyle('session')}`}
          ?hidden=${sessionHidden}
        >
          <acp-session-column></acp-session-column>
        </acp-pane>
        ${sessionHidden ? nothing : this.#renderResizer('session', 'Resize sessions column')}
        <acp-pane style=${agentFills ? AGENT_FILL_PANE : `${AGENT_PANE}; ${this.#resize.columnStyle('agent')}`}>
          <acp-agent-column
            @acp-file-open=${this.#onChatFileOpen}
            @acp-file-reveal=${this.#onChatFileReveal}
          ></acp-agent-column>
        </acp-pane>
        ${agentFills ? nothing : this.#renderResizer('agent', 'Resize agent column')}
        <acp-pane style=${MAIN_PANE} ?hidden=${!hasCode}>
          <acp-main-column @acp-file-reveal=${this.#onFileReveal}></acp-main-column>
        </acp-pane>
        ${filesHidden ? nothing : this.#renderResizer('side', 'Resize file column', 'start')}
        <acp-pane
          edge="start"
          style=${filesHidden ? FILES_PANE : `${FILES_PANE}; ${this.#resize.columnStyle('side')}`}
          ?hidden=${filesHidden}
        >
          <acp-file-column
            @acp-file-open=${this.#onFileOpen}
            @acp-diff-open=${this.#onDiffOpen}
          ></acp-file-column>
        </acp-pane>
        <acp-nav-rail
          .selected=${this.sideView}
          @acp-show-files=${this.#showFiles}
          @acp-find-in-files=${this.#showSearch}
          @acp-show-changes=${this.#showChanges}
          @acp-open-terminal=${this.#openProjectTerminal}
          @acp-show-settings=${this.#showSettings}
        ></acp-nav-rail>
      </acp-split>
    </acp-panel>
      <acp-quick-open
        .hasProject=${this.#rootId.value !== null}
        .files=${this.quickOpenFiles}
        @acp-quick-open-query=${this.#onPaletteQuery}
        @acp-quick-open-pick=${this.#onPalettePick}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
      <acp-search-dialog
        .hasProject=${this.#rootId.value !== null}
        .results=${this.#search.results}
        .searching=${this.#search.searching}
        .limitHit=${this.#search.limitHit}
        .error=${this.#search.error}
        .errorSource=${this.#search.errorSource}
        .recent=${this.#savedSearch?.recent ?? []}
        .folders=${this.searchFolders}
        .foldersQuery=${this.searchFoldersQuery}
        .previewPosition=${this.#searchPrefs.value.preview}
        .view=${this.#searchPrefs.value.view}
        @acp-search-dialog-query=${this.#onSearchQuery}
        @acp-search-dialog-close=${this.#onSearchClose}
        @acp-search-dialog-folders=${this.#onSearchFolders}
        @acp-search-dialog-open=${this.#onSearchOpen}
        @acp-search-dialog-popout=${this.#onSearchPopout}
        @acp-search-dialog-prefs=${this.#onSearchPrefs}
      ></acp-search-dialog>
      <acp-about-dialog .about=${this.#about.value} @acp-reveal-path=${this.#onRevealPath}></acp-about-dialog>
      <acp-confirm-dialog class="acp-app__trust"></acp-confirm-dialog>
      <acp-snackbars
        .notices=${this.#notices.value}
        @acp-notice-dismiss=${(/** @type {CustomEvent<{ id: number }>} */ e) => dismissNotice(e.detail.id)}
        @acp-notice-action=${(/** @type {CustomEvent<{ id: number }>} */ e) => runNoticeAction(e.detail.id)}
        @acp-notices-hold=${(/** @type {CustomEvent<{ held: boolean }>} */ e) => holdNotices(e.detail.held)}
      ></acp-snackbars>
    `;
  }
}

customElements.define('acp-app', AcpApp);
