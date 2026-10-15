import { LitElement, html, nothing } from 'lit';
import { sessionController } from '../../services/session-controller.js';
import { projectController } from '../../services/project-controller.js';
import { gitController } from '../../services/git-controller.js';
import { onMenuAction } from '../../services/ipc.js';
import { log } from '../../services/logger.js';
import { reportError } from '../../services/notices.js';
import { $activePath, openBrowser, openTerminal } from '../../stores/editor.js';
import { $columnWidths, $hiddenColumns, showColumn } from '../../stores/layout.js';
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

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor/file columns, Quick Open, About, snackbars, global shortcuts and menu bar items.
 */
export class AcpApp extends LitElement {
  static properties = {
    sideView: { state: true },
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
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKeydown);
    this.#menuListener = onMenuAction(this.#onMenuAction);
    this.#menuListener.catch((err) => log('warn', `menu bar not connected: ${err}`));
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
  #onPaletteFileOpen(e) {
    e.stopPropagation();
    this.#main.openFile(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path);
  }

  /** @param {Event} e */
  #onFileOpen(e) {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.#main.openFile(path, line);
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
    // With neither tabs nor files beside it, the agent column takes the space.
    const agentFills = !hasCode && filesHidden;
    return html`
      <acp-toolbar class="acp-app__toolbar"></acp-toolbar>
      <div class="acp-app__columns">
        <acp-session-column class="acp-app__session" ?hidden=${sessionHidden}></acp-session-column>
        ${sessionHidden ? nothing : this.#renderResizer('session', 'Resize sessions column')}
        <acp-agent-column class="acp-app__agent ${agentFills ? 'acp-app__agent_fill' : ''}"></acp-agent-column>
        ${agentFills ? nothing : this.#renderResizer('agent', 'Resize agent column')}
        <acp-main-column class="acp-app__main" ?hidden=${!hasCode}></acp-main-column>
        ${hasCode && !filesHidden ? this.#renderResizer('side', 'Resize file column', 'start') : nothing}
        <acp-file-column
          class="acp-app__files ${hasCode ? 'acp-app__files_with-code' : ''}"
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
          @acp-show-terminal=${openTerminal}
          @acp-show-browser=${openBrowser}
          @acp-show-settings=${this.#showSettings}
        ></acp-nav-rail>
      </div>
      <acp-quick-open
        @acp-file-open=${this.#onPaletteFileOpen}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
      <acp-about-dialog></acp-about-dialog>
      <acp-snackbars class="acp-app__snackbars"></acp-snackbars>
    `;
  }
}

customElements.define('acp-app', AcpApp);
