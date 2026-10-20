import { LitElement, html, nothing } from 'lit';
import { agentConfig } from '../../services/agent-config.js';
import { sessionController } from '../../services/session-controller.js';
import { projectController } from '../../services/project-controller.js';
import { gitController } from '../../services/git-controller.js';
import { loadAbout } from '../../services/about.js';
import { onMenuAction, quickOpen, revealPath } from '../../services/ipc.js';
import { log } from '../../services/logger.js';
import { reportError } from '../../services/notices.js';
import { $about } from '../../stores/about.js';
import { $activePath } from '../../stores/editor.js';
import { $gitRepo } from '../../stores/git.js';
import { $columnWidths, $hiddenColumns, showColumn, toggleColumn } from '../../stores/layout.js';
import { $notices, dismissNotice, holdNotices } from '../../stores/notices.js';
import { $rootId, $workspace } from '../../stores/workspace.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../acp-about-dialog/acp-about-dialog.js';
import '../acp-toolbar/acp-toolbar.js';
import '../acp-session-column/acp-session-column.js';
import '../acp-agent-column/acp-agent-column.js';
import '../acp-main-column/acp-main-column.js';
import '../acp-file-column/acp-file-column.js';
import '../acp-nav-rail/acp-nav-rail.js';
import '../acp-quick-open/acp-quick-open.js';
import '../acp-resize-handle/acp-resize-handle.js';
import '../acp-snackbars/acp-snackbars.js';
import { ColumnResizeController } from '../../controllers/resize/ColumnResizeController.js';
import styles from './acp-app.css?inline';

/** @typedef {import('../acp-file-column/acp-file-column.js').SideView} SideView */
/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor/file columns, Quick Open, About, snackbars, global shortcuts and menu bar items.
 */
export class AcpApp extends LitElement {
  static properties = {
    sideView: { state: true },
    quickOpenFiles: { state: true },
  };

  static styles = styles;

  #resize = new ColumnResizeController(this, {
    store: $columnWidths,
    columns: {
      session: { property: '--session-column-width', min: 180, max: 524, partner: 'agent' },
      agent: { property: '--agent-column-width', min: 280, max: 1600 },
      side: { property: '--file-tree-width', min: 200, max: 524 },
    },
  });
  #activePath = new StoreController(this, { store: $activePath });
  #hiddenColumns = new StoreController(this, { store: $hiddenColumns });
  #workspace = new StoreController(this, { store: $workspace });
  #rootId = new StoreController(this, { store: $rootId });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #notices = new StoreController(this, { store: $notices });
  #about = new StoreController(this, { store: $about });
  /** Sequence of Quick Open queries; only the latest answer is shown. */
  #quickOpenRequest = 0;
  /** @type {Promise<() => void> | null} */
  #menuListener = null;

  #onMenuAction = (/** @type {'about' | 'settings'} */ id) => {
    if (id === 'about') this.#showAbout();
    else this.#showSettings();
  };

  /** Cmd/Ctrl+P: Quick Open. Cmd/Ctrl+Shift+F: Find in Files. */
  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'p' && !e.shiftKey) {
      e.preventDefault();
      this.#showQuickOpen();
    } else if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      this.#showSearch();
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
    window.addEventListener('keydown', this.#onKeydown);
    this.#menuListener = onMenuAction(this.#onMenuAction);
    this.#menuListener.catch((err) => log('warn', `menu bar not connected: ${err}`));
    agentConfig.start();
    sessionController.init().catch((err) => reportError('Loading sessions failed', err));
    gitController.start();
    projectController.restore().catch((err) => reportError('Reopening folder failed', err));
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.#onKeydown);
    this.#menuListener?.then((stop) => stop()).catch(() => {});
    this.#menuListener = null;
    super.disconnectedCallback();
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
    loadAbout();
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
      reportError('File search failed', err);
    }
  }

  /** @param {Event} e */
  #onPalettePick(e) {
    this.#main.openFile(projectController.absPath(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path));
  }

  /** @param {Event} e */
  #onColumnToggle(e) {
    toggleColumn(/** @type {CustomEvent<{ column: string }>} */ (e).detail.column);
  }

  /** @param {Event} e */
  #onRevealPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    revealPath(path).catch((err) => log('warn', `showing logs failed: ${err}`));
  }

  /** @param {Event} e */
  #onFileOpen(e) {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.#main.openFile(path, line);
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
   * @param {string} path Absolute; outside the project there's no row to show.
   * @param {{ expand?: boolean }} [options] Expand a folder itself too.
   */
  async #revealInTree(path, options) {
    const rel = projectController.relPath(path);
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
      class="acp-app__resizer"
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
    // With no tabs beside it, the agent column takes the space.
    const agentFills = !hasCode;
    return html`
      <acp-toolbar
        class="acp-app__toolbar"
        .workspace=${this.#workspace.value}
        .git=${this.#gitRepo.value}
        .hiddenColumns=${hidden}
        @acp-column-toggle=${this.#onColumnToggle}
      ></acp-toolbar>
      <div class="acp-app__columns">
        <acp-session-column
          class="acp-app__session"
          style=${this.#resize.columnStyle('session')}
          ?hidden=${sessionHidden}
        ></acp-session-column>
        ${sessionHidden ? nothing : this.#renderResizer('session', 'Resize sessions column')}
        <acp-agent-column
          class="acp-app__agent ${agentFills ? 'acp-app__agent_fill' : ''}"
          style=${agentFills ? nothing : this.#resize.columnStyle('agent')}
          @acp-file-open=${this.#onChatFileOpen}
          @acp-file-reveal=${this.#onChatFileReveal}
        ></acp-agent-column>
        ${agentFills ? nothing : this.#renderResizer('agent', 'Resize agent column')}
        <acp-main-column class="acp-app__main" ?hidden=${!hasCode}></acp-main-column>
        ${filesHidden ? nothing : this.#renderResizer('side', 'Resize file column', 'start')}
        <acp-file-column
          class="acp-app__files"
          style=${this.#resize.columnStyle('side')}
          ?hidden=${filesHidden}
          @acp-file-open=${this.#onFileOpen}
          @acp-diff-open=${this.#onDiffOpen}
        ></acp-file-column>
        <acp-nav-rail
          class="acp-app__rail"
          .selected=${this.sideView}
          @acp-show-files=${this.#showFiles}
          @acp-find-in-files=${this.#showSearch}
          @acp-show-changes=${this.#showChanges}
          @acp-show-settings=${this.#showSettings}
        ></acp-nav-rail>
      </div>
      <acp-quick-open
        .hasProject=${this.#rootId.value !== null}
        .files=${this.quickOpenFiles}
        @acp-quick-open-query=${this.#onPaletteQuery}
        @acp-quick-open-pick=${this.#onPalettePick}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
      <acp-about-dialog .about=${this.#about.value} @acp-reveal-path=${this.#onRevealPath}></acp-about-dialog>
      <acp-snackbars
        class="acp-app__snackbars"
        .notices=${this.#notices.value}
        @acp-notice-dismiss=${(/** @type {CustomEvent<{ id: number }>} */ e) => dismissNotice(e.detail.id)}
        @acp-notices-hold=${(/** @type {CustomEvent<{ held: boolean }>} */ e) => holdNotices(e.detail.held)}
      ></acp-snackbars>
    `;
  }
}

customElements.define('acp-app', AcpApp);
