import { LitElement, html, nothing } from 'lit';
import { projectController } from '../../services/project-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $activePath, openChanges as openChangesTab, openSettings as openSettingsTab } from '../../stores/editor.js';
import { $columnWidths } from '../../stores/layout.js';
import '../acp-code-editor/acp-code-editor.js';
import '../acp-file-tree/acp-file-tree.js';
import '../acp-search-panel/acp-search-panel.js';
import '../acp-changes-panel/acp-changes-panel.js';
import '../acp-resize-handle/acp-resize-handle.js';
import { ColumnResizeController } from '../../controllers/resize/ColumnResizeController.js';
import styles from './acp-main-column.css?inline';

/** @typedef {'files' | 'search' | 'changes'} SideView */

/** @type {Record<SideView, string>} */
const SIDE_TITLES = { files: 'Files', search: 'Search', changes: 'Changes' };

/**
 * @tag acp-main-column
 * @summary The main column: everything opens in its tabs (files, Changes, Settings), beside the Files / Search / Changes side pane.
 */
export class AcpMainColumn extends LitElement {
  static properties = {
    sideView: { state: true },
  };

  static styles = styles;

  #resize = new ColumnResizeController(this, {
    store: $columnWidths,
    columns: { side: { property: '--file-tree-width', min: 200, max: 640 } },
  });

  #onFileOpen = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.openFile(path, line);
  };
  #onDiffOpen = (/** @type {Event} */ e) => {
    this.showChange(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path);
  };
  #activePath = new StoreController(this, { store: $activePath });

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-file-open', this.#onFileOpen);
    this.addEventListener('acp-diff-open', this.#onDiffOpen);
  }

  disconnectedCallback() {
    this.removeEventListener('acp-file-open', this.#onFileOpen);
    this.removeEventListener('acp-diff-open', this.#onDiffOpen);
    super.disconnectedCallback();
  }

  /** Rendered unconditionally, so present after the first render. */
  get #codeEditor() {
    return /** @type {HTMLElementTagNameMap['acp-code-editor']} */ (
      this.renderRoot.querySelector('acp-code-editor')
    );
  }

  /**
   * Opens a file in a tab, or switches to its tab.
   * @param {string} path Absolute.
   * @param {number | null} [line] 1-based line to put the caret on.
   */
  openFile(path, line = null) {
    this.#codeEditor.show(path, line);
    projectController.noteOpened(path);
  }

  /**
   * Opens the Changes tab with a file's diff expanded and scrolled into view.
   * @param {string} path Absolute.
   */
  showChange(path) {
    openChangesTab();
    this.#codeEditor.revealChange(path);
  }

  /** Opens the Settings tab, or switches to it. */
  openSettings() {
    openSettingsTab();
  }

  /**
   * Moves the caret in the open file. No-op without one.
   * @param {number} line 1-based.
   */
  goToLine(line) {
    const path = this.#activePath.value;
    if (path !== null) this.#codeEditor.show(path, line);
  }

  /** Switches the side pane to Files. */
  showFiles() {
    this.sideView = 'files';
  }

  /** Switches the side pane to Search and focuses its input. */
  async showSearch() {
    this.sideView = 'search';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-search-panel')?.focusInput();
  }

  /** Switches the side pane to Changes, which computes them while shown. */
  showChanges() {
    this.sideView = 'changes';
  }

  /** Divider on the side pane's left edge; only there while code takes the rest. */
  #renderResizer() {
    const { value, min, max } = this.#resize.column('side');
    return html`<acp-resize-handle
      class="acp-main-column__resizer"
      name="side"
      edge="start"
      label="Resize side pane"
      .value=${value}
      .min=${min}
      .max=${max}
    ></acp-resize-handle>`;
  }

  render() {
    const hasCode = this.#activePath.value !== null;
    return html`
      <acp-code-editor class="acp-main-column__code" ?hidden=${!hasCode}></acp-code-editor>
      ${hasCode ? this.#renderResizer() : nothing}
      <div class="acp-main-column__side ${hasCode ? 'acp-main-column__side_with-code' : ''}">
        <h2 class="acp-main-column__title">${SIDE_TITLES[this.sideView]}</h2>
        <acp-file-tree class="acp-main-column__pane" ?hidden=${this.sideView !== 'files'}></acp-file-tree>
        <acp-search-panel
          class="acp-main-column__pane"
          ?hidden=${this.sideView !== 'search'}
          .active=${this.sideView === 'search'}
        ></acp-search-panel>
        <acp-changes-panel
          class="acp-main-column__pane"
          ?hidden=${this.sideView !== 'changes'}
          .active=${this.sideView === 'changes'}
        ></acp-changes-panel>
      </div>
    `;
  }
}

customElements.define('acp-main-column', AcpMainColumn);
