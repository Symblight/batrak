import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { agents } from '../../hooks/agents/agents.js';
import { html, nothing } from 'lit';
import { sessions } from '../../hooks/sessions/sessions.js';
import { git } from '../../hooks/git/git.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { search } from '../../hooks/search/search.js';
import { $about } from '../../stores/about/about.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $columnWidths, $hiddenColumns, showColumn, toggleColumn } from '../../stores/layout/layout.js';
import { $notices, dismissNotice, holdNotices, runNoticeAction } from '../../stores/notices/notices.js';
import { $treeRoot } from '../../stores/session-root/session-root.js';
import { $worktrees } from '../../stores/sessions/sessions.js';
import { $trustPrompt } from '../../stores/trust/trust.js';
import { $rootId, $workspace } from '../../stores/workspace/workspace.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/about-dialog/about-dialog.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/toolbar/toolbar.js';
import '../session-column/session-column.js';
import '../agent-column/agent-column.js';
import '../main-column/main-column.js';
import '../file-column/file-column.js';
import '../../components/nav-rail/nav-rail.js';
import '../../components/quick-open/quick-open.js';
import '../search-view/search-view.js';
import '../../components/snackbars/snackbars.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/column-split/column-split.js';

/** @typedef {import('../file-column/file-column.js').SideView} SideView */
/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/agents/types.js').TrustPrompt} TrustPrompt */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/*
 * The row of columns. Session and file columns shrink, down to their resize minimums, to fit the main
 * column's minimum only once the agent column (its far larger shrink factor) is at its own; a drag
 * starts from the rendered width.
 */
/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} */
const COLUMNS = [
  {
    name: 'session',
    size: '--acp-session-column-width',
    minSize: '--acp-session-column-min-width',
    maxSize: '--acp-column-max-width',
    collapse: 'end',
    resize: { min: 180, max: 524, partner: 'agent', label: 'Resize sessions column' },
  },
  {
    name: 'agent',
    size: '--acp-agent-column-width',
    minSize: '--acp-agent-column-min-width',
    shrink: 1000,
    resize: { min: 280, max: 1600, label: 'Resize agent column' },
  },
  { name: 'main', minSize: '--acp-main-column-min-width' },
  {
    name: 'side',
    size: '--acp-file-tree-width',
    minSize: '--acp-file-tree-min-width',
    maxSize: '--acp-column-max-width',
    collapse: 'start',
    resize: { min: 200, max: 524, label: 'Resize file column', edge: 'start' },
  },
];

/** @type {readonly string[]} The same array each render, so the row sees no change. */
const NO_COLUMNS = Object.freeze([]);
/** @type {readonly string[]} */
const AGENT_FILLS = Object.freeze(['agent']);

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor/file columns, Quick Open, the search dialog, About, the project trust dialog, snackbars, global shortcuts and menu bar items.
 */
export class AcpApp extends ViewElement {
  static properties = {
    sideView: { state: true },
    quickOpenFiles: { state: true },
  };

  #columnWidths = new StoreController(this, { store: $columnWidths });
  #activePath = new StoreController(this, { store: $activePath });
  #hiddenColumns = new StoreController(this, { store: $hiddenColumns });
  #workspace = new StoreController(this, { store: $workspace });
  #rootId = new StoreController(this, { store: $rootId });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #notices = new StoreController(this, { store: $notices });
  #about = new StoreController(this, { store: $about });
  #trustPrompt = new StoreController(this, { store: $trustPrompt, onChange: (prompt) => this.#askTrust(prompt) });
  /** Sequence of Quick Open queries; only the latest answer is shown. */
  #quickOpenRequest = 0;
  /** @type {Promise<() => void> | null} */
  #menuListener = null;

  #onMenuAction = (/** @type {import('../../hooks/app/app.js').MenuAction} */ id) => {
    if (id === 'about') this.#showAbout();
    else if (id === 'new-terminal') this.#newTerminal();
    else this.#showSettings();
  };

  #newTerminal() {
    terminals.newTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  #openProjectTerminal() {
    terminals.projectTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
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
    if (this.#searchView?.open) return;
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
  }

  connectedCallback() {
    super.connectedCallback();
    // First: the previous page load's shells must be closed before anything opens one.
    terminals.start();
    window.addEventListener('keydown', this.#onKeydown);
    this.#menuListener = app.onMenuAction(this.#onMenuAction);
    this.#menuListener.catch((err) => app.log('warn', `menu bar not connected: ${err}`));
    agents.start();
    sessions.init().catch((err) => app.reportError('Loading sessions failed', err));
    git.start();
    sessions.followRoot();
    projects.restore().catch((err) => app.reportError('Reopening folder failed', err));
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
    const trusted = await dialog.confirm(agents.trustConfirm(prompt));
    if ($trustPrompt.get() !== prompt) return;
    if (!trusted) agents.dismissTrust();
    else for (const id of await agents.trust()) sessions.restart(id);
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
      const result = await search.quickOpen(rootId, query);
      if (id !== this.#quickOpenRequest || result.cancelled) return;
      this.quickOpenFiles = result.items;
    } catch (err) {
      app.reportError('File search failed', err);
    }
  }

  /** @param {Event} e */
  #onPalettePick(e) {
    this.#main.openFile(projects.absPath(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path));
  }

  /** @returns {HTMLElementTagNameMap['acp-search-view'] | null} */
  get #searchView() {
    return this.renderRoot.querySelector('acp-search-view');
  }

  /** Opens the search dialog with the project's last search, or the editor's selection; open, selects the query. */
  #showSearchDialog() {
    this.#searchView?.show(this.#main.selectedText());
  }

  /**
   * A match from the dialog: its tab, with the match selected.
   * @param {Event} e
   */
  #onSearchOpen(e) {
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number }>} */ (e).detail;
    this.#main.openFile(path, { line, column, length });
  }

  /**
   * "Open in panel": the side column's Search pane takes the dialog's search.
   * @param {Event} e
   */
  #onSearchPopout(e) {
    const { state } = /** @type {CustomEvent<{ state: SearchDialogState }>} */ (e).detail;
    this.sideView = 'search';
    showColumn('side');
    this.#files.showSearch(state);
  }

  /** @param {Event} e */
  #onColumnToggle(e) {
    toggleColumn(/** @type {CustomEvent<{ column: string }>} */ (e).detail.column);
  }

  /** @param {Event} e */
  #onRevealPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    projects.reveal(path).catch((err) => app.log('warn', `showing logs failed: ${err}`));
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
    const rel = projects.rel($treeRoot.get().path, path) ?? projects.rel(projects.path(), projects.projectPathOf($worktrees.get(), path));
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

  render() {
    const hasCode = this.#activePath.value !== null;
    const hidden = this.#hiddenColumns.value;
    return html`<acp-panel variant="window">
      <acp-toolbar
        slot="header"
        .workspace=${this.#workspace.value}
        .git=${this.#gitRepo.value}
        .hiddenColumns=${hidden}
        @acp-column-toggle=${this.#onColumnToggle}
      ></acp-toolbar>
      <!-- With no tabs, the main column is hidden and the agent column takes the space. -->
      <acp-column-split
        .columns=${COLUMNS}
        .widths=${this.#columnWidths.value}
        .hiddenColumns=${hasCode ? hidden : [...hidden, 'main']}
        .fillColumns=${hasCode ? NO_COLUMNS : AGENT_FILLS}
        @acp-columns-resize=${(/** @type {CustomEvent<{ widths: import('../../hooks/settings/types.js').ColumnWidths }>} */ e) => $columnWidths.set(e.detail.widths)}
      >
        <acp-session-column slot="session"></acp-session-column>
        <acp-agent-column
          slot="agent"
          @acp-file-open=${this.#onChatFileOpen}
          @acp-file-reveal=${this.#onChatFileReveal}
        ></acp-agent-column>
        <acp-main-column slot="main" @acp-file-reveal=${this.#onFileReveal}></acp-main-column>
        <acp-file-column
          slot="side"
          @acp-file-open=${this.#onFileOpen}
          @acp-diff-open=${this.#onDiffOpen}
        ></acp-file-column>
        <acp-nav-rail
          .selected=${this.sideView}
          @acp-show-files=${this.#showFiles}
          @acp-find-in-files=${this.#showSearch}
          @acp-show-changes=${this.#showChanges}
          @acp-open-terminal=${this.#openProjectTerminal}
          @acp-show-settings=${this.#showSettings}
        ></acp-nav-rail>
      </acp-column-split>
    </acp-panel>
      <acp-quick-open
        .hasProject=${this.#rootId.value !== null}
        .files=${this.quickOpenFiles}
        @acp-quick-open-query=${this.#onPaletteQuery}
        @acp-quick-open-pick=${this.#onPalettePick}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
      <acp-search-view @acp-search-open=${this.#onSearchOpen} @acp-search-popout=${this.#onSearchPopout}></acp-search-view>
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
