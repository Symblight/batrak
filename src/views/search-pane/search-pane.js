import { html } from 'lit';
import { projects } from '../../hooks/projects/projects.js';
import { search } from '../../hooks/search/search.js';
import { $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import '../../components/search-panel/search-panel.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/search/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/**
 * @tag acp-search-pane
 * @summary The Search pane wired to its data: the search in files (the `'panel'` slot) and its results.
 * @fires acp-file-open `{ path, line, column, length }` A match to open: an absolute path, the match's 1-based position.
 */
export class AcpSearchPane extends ViewElement {
  static properties = {
    active: { type: Boolean },
  };

  #project = new StoreController(this, { store: $project });
  #search = new FindInFilesController(this, { slot: 'panel' });

  constructor() {
    super();
    /** @type {boolean} The pane is the shown one; hidden, it does no work. */
    this.active = false;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('active')) this.#search.setActive(this.active);
  }

  /**
   * Fills the search from one handed over by the dialog (its folder and mask as the include / exclude filters), runs it, and focuses the query.
   * @param {SearchDialogState} [state]
   */
  show(state) {
    const panel = this.renderRoot.querySelector('acp-search-panel');
    if (state) {
      const { query, caseSensitive, wholeWord, regex, folder, mask } = state;
      panel?.setOptions({ query, caseSensitive, wholeWord, regex, ...search.filters(folder, mask) });
    }
    panel?.focusInput();
  }

  /** @param {Event} e */
  #onSearch(e) {
    e.stopPropagation();
    const { options, delay } = /** @type {CustomEvent<{ options: SearchOptions, delay: number }>} */ (e).detail;
    this.#search.search(options, delay);
  }

  /** @param {Event} e */
  #onOpen(e) {
    e.stopPropagation();
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number }>} */ (e).detail;
    const root = this.#project.value?.path ?? null;
    this.dispatchEvent(
      new CustomEvent('acp-file-open', { detail: { path: projects.abs(root, path), line, column, length }, bubbles: true, composed: true }),
    );
  }

  render() {
    const search = this.#search;
    return html`<acp-search-panel
      .results=${search.results}
      .searching=${search.searching}
      .limitHit=${search.limitHit}
      .error=${search.error}
      @acp-search=${this.#onSearch}
      @acp-search-panel-open=${this.#onOpen}
    ></acp-search-panel>`;
  }
}

customElements.define('acp-search-pane', AcpSearchPane);
