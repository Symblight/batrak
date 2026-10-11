import { LitElement, html } from 'lit';
import '../acp-file-tree/acp-file-tree.js';
import '../acp-search-panel/acp-search-panel.js';
import '../acp-changes-panel/acp-changes-panel.js';
import styles from './acp-file-column.css?inline';

/** @typedef {'files' | 'search' | 'changes'} SideView */

/** @type {Record<SideView, string>} */
const SIDE_TITLES = { files: 'Files', search: 'Search', changes: 'Changes' };

/**
 * @tag acp-file-column
 * @summary The project column: one of Files, Search or Changes, picked from the nav rail.
 */
export class AcpFileColumn extends LitElement {
  static properties = {
    sideView: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {SideView} */
    this.sideView = 'files';
  }

  /** Switches to Files. */
  showFiles() {
    this.sideView = 'files';
  }

  /** Switches to Search and focuses its input. */
  async showSearch() {
    this.sideView = 'search';
    await this.updateComplete;
    this.renderRoot.querySelector('acp-search-panel')?.focusInput();
  }

  /** Switches to Changes, which computes them while shown. */
  showChanges() {
    this.sideView = 'changes';
  }

  render() {
    return html`
      <h2 class="acp-file-column__title">${SIDE_TITLES[this.sideView]}</h2>
      <acp-file-tree class="acp-file-column__pane" ?hidden=${this.sideView !== 'files'}></acp-file-tree>
      <acp-search-panel
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'search'}
        .active=${this.sideView === 'search'}
      ></acp-search-panel>
      <acp-changes-panel
        class="acp-file-column__pane"
        ?hidden=${this.sideView !== 'changes'}
        .active=${this.sideView === 'changes'}
      ></acp-changes-panel>
    `;
  }
}

customElements.define('acp-file-column', AcpFileColumn);
