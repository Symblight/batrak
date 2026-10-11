import { LitElement, html } from 'lit';
import { projectController } from '../../services/project-controller.js';
import { $activePath, openChanges as openChangesTab, openSettings as openSettingsTab } from '../../stores/editor.js';
import '../acp-tab-view/acp-tab-view.js';
import styles from './acp-main-column.css?inline';

/**
 * @tag acp-main-column
 * @summary The main column: everything opens in its tabs (files, Changes, Settings).
 */
export class AcpMainColumn extends LitElement {
  static styles = styles;

  #onFileOpen = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.openFile(path, line);
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-file-open', this.#onFileOpen);
  }

  disconnectedCallback() {
    this.removeEventListener('acp-file-open', this.#onFileOpen);
    super.disconnectedCallback();
  }

  /** Rendered unconditionally, so present after the first render. */
  get #tabView() {
    return /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
      this.renderRoot.querySelector('acp-tab-view')
    );
  }

  /**
   * Opens a file in a tab, or switches to its tab.
   * @param {string} path Absolute.
   * @param {number | null} [line] 1-based line to put the caret on.
   */
  openFile(path, line = null) {
    this.#tabView.show(path, line);
    projectController.noteOpened(path);
  }

  /**
   * Opens the Changes tab with a file's diff expanded and scrolled into view.
   * @param {string} path Absolute.
   */
  showChange(path) {
    openChangesTab();
    this.#tabView.revealChange(path);
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
    const path = $activePath.get();
    if (path !== null) this.#tabView.show(path, line);
  }

  render() {
    return html`<acp-tab-view class="acp-main-column__tabs"></acp-tab-view>`;
  }
}

customElements.define('acp-main-column', AcpMainColumn);
