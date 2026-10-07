import { LitElement, html } from 'lit';
import { sessionController } from '../../services/session-controller.js';
import { projectController } from '../../services/project-controller.js';
import { gitController } from '../../services/git-controller.js';
import { $activePath } from '../../stores/editor.js';
import { $columnWidths } from '../../stores/layout.js';
import '../acp-toolbar/acp-toolbar.js';
import '../acp-session-column/acp-session-column.js';
import '../acp-agent-column/acp-agent-column.js';
import '../acp-main-column/acp-main-column.js';
import '../acp-nav-rail/acp-nav-rail.js';
import '../acp-quick-open/acp-quick-open.js';
import '../acp-resize-handle/acp-resize-handle.js';
import { ColumnResizeController } from '../../controllers/resize/ColumnResizeController.js';
import styles from './acp-app.css?inline';

/** @typedef {import('../acp-main-column/acp-main-column.js').SideView} SideView */

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor columns, Quick Open and global shortcuts.
 */
export class AcpApp extends LitElement {
  static properties = {
    sideView: { state: true },
  };

  static styles = styles;

  #resize = new ColumnResizeController(this, {
    store: $columnWidths,
    columns: {
      session: { property: '--session-column-width', min: 180, max: 480 },
      agent: { property: '--agent-column-width', min: 280, max: 1600 },
    },
  });

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
    /** @type {SideView} Mirrors the editor column's side pane, for the rail's pressed button. */
    this.sideView = 'files';
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.#onKeydown);
    sessionController.init().catch((err) => console.error('Brama: init failed', err));
    gitController.start();
    projectController.restore().catch((err) => console.error('Brama: reopening folder failed', err));
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.#onKeydown);
    super.disconnectedCallback();
  }

  /** Rendered unconditionally, so present after the first render. */
  get #main() {
    return /** @type {HTMLElementTagNameMap['acp-main-column']} */ (
      this.renderRoot.querySelector('acp-main-column')
    );
  }

  #showFiles() {
    this.sideView = 'files';
    this.#main.showFiles();
  }

  #showSearch() {
    this.sideView = 'search';
    this.#main.showSearch();
  }

  #showChanges() {
    this.sideView = 'changes';
    this.#main.showChanges();
  }

  #showSettings() {
    this.#main.openSettings();
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
  #onPaletteGoToLine(e) {
    this.#main.goToLine(/** @type {CustomEvent<{ line: number }>} */ (e).detail.line);
  }

  /**
   * Divider after a column, resizing it.
   * @param {string} name Column id in `#resize`.
   * @param {string} label
   */
  #renderResizer(name, label) {
    const { value, min, max } = this.#resize.column(name);
    return html`<acp-resize-handle
      class="acp-app__resizer"
      name=${name}
      label=${label}
      .value=${value}
      .min=${min}
      .max=${max}
    ></acp-resize-handle>`;
  }

  render() {
    return html`
      <acp-toolbar class="acp-app__toolbar"></acp-toolbar>
      <div class="acp-app__columns">
        <acp-session-column class="acp-app__session"></acp-session-column>
        ${this.#renderResizer('session', 'Resize sessions column')}
        <acp-agent-column class="acp-app__agent"></acp-agent-column>
        ${this.#renderResizer('agent', 'Resize agent column')}
        <acp-main-column class="acp-app__main"></acp-main-column>
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
        @acp-file-open=${this.#onPaletteFileOpen}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
    `;
  }
}

customElements.define('acp-app', AcpApp);
