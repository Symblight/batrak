import { html } from 'lit';
import { app } from '../../hooks/app/app.js';
import { projects } from '../../hooks/projects/projects.js';
import { search } from '../../hooks/search/search.js';
import { $projectSearch, $searchDialogPrefs, addRecentSearch, saveProjectSearch, setSearchDialogPrefs } from '../../stores/search/search.js';
import { $rootId, $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { FindInFilesController } from '../../controllers/find-in-files/FindInFilesController.js';
import '../../components/search-dialog/search-dialog.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../hooks/search/types.js').SearchDialogPrefs} SearchDialogPrefs */
/** @typedef {import('../../hooks/search/types.js').SearchOptions} SearchOptions */

/** @type {SearchDialogState} A project's search before its first one. */
const NO_SEARCH = { query: '', caseSensitive: false, wholeWord: false, regex: false, folder: '', mask: '' };

/**
 * @tag acp-search-view
 * @summary The search dialog wired to its data: the project's last search and recent queries, the search in files (the `'dialog'` slot), the folder menu's folders and the layout preferences.
 * @fires acp-search-open `{ path, line, column, length }` A match to open: an absolute path, the match's 1-based position.
 * @fires acp-search-popout `{ state }` "Open in panel": the side column's Search pane takes this search.
 */
export class AcpSearchView extends ViewElement {
  static properties = {
    folders: { state: true },
    foldersQuery: { state: true },
  };

  #project = new StoreController(this, { store: $project });
  #rootId = new StoreController(this, { store: $rootId });
  #prefs = new StoreController(this, { store: $searchDialogPrefs });
  #saved = new StoreController(this, { store: $projectSearch });
  #search = new FindInFilesController(this, { slot: 'dialog' });
  /** Sequence of folder questions; only the latest answer is kept. */
  #foldersRequest = 0;

  constructor() {
    super();
    /** @type {QuickOpenItem[]} The folder menu's folders. */
    this.folders = [];
    /** @type {string | null} The query `folders` answers. */
    this.foldersQuery = null;
  }

  /** @returns {HTMLElementTagNameMap['acp-search-dialog'] | null} */
  get #dialog() {
    return this.renderRoot?.querySelector('acp-search-dialog') ?? null;
  }

  /** Whether the dialog is open. */
  get open() {
    return this.#dialog?.open ?? false;
  }

  /** The open project's last search and recent queries. */
  get #savedSearch() {
    const project = this.#project.value?.path;
    return project ? this.#saved.value[project] : undefined;
  }

  /**
   * Opens the dialog with the project's last search, or the editor's selection; open, selects the query.
   * @param {string} [selection] The editor's selected text.
   */
  show(selection) {
    const { query, caseSensitive, wholeWord, regex, folder, mask } = this.#savedSearch ?? NO_SEARCH;
    return this.#dialog?.show({ query, caseSensitive, wholeWord, regex, folder, mask }, selection);
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onQuery(e) {
    e.stopPropagation();
    const { options, state, delay } = /** @type {CustomEvent<{ options: SearchOptions, state: SearchDialogState, delay: number }>} */ (e).detail;
    this.#search.setActive(true);
    this.#search.search(options, delay);
    const project = this.#project.value?.path;
    if (project) saveProjectSearch(project, state);
  }

  /** @param {Event} e */
  #onClose(e) {
    e.stopPropagation();
    this.#search.setActive(false);
  }

  /** @param {Event} e */
  async #onFolders(e) {
    e.stopPropagation();
    const { query } = /** @type {CustomEvent<{ query: string }>} */ (e).detail;
    const id = ++this.#foldersRequest;
    const rootId = this.#rootId.value;
    if (rootId === null) {
      this.folders = [];
      this.foldersQuery = query;
      return;
    }
    try {
      const result = await search.quickOpen(rootId, query, 'dirs');
      if (id !== this.#foldersRequest || result.cancelled) return;
      this.folders = result.items;
      this.foldersQuery = query;
    } catch (err) {
      app.reportError('Folder search failed', err);
    }
  }

  /**
   * A match from the dialog: remembered, and handed on to be opened.
   * @param {Event} e
   */
  #onOpen(e) {
    e.stopPropagation();
    const { path, line, column, length, state } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number, state: SearchDialogState }>} */ (
      e
    ).detail;
    this.#record(state.query);
    this.#emit('acp-search-open', { path: projects.absPath(path), line, column, length });
  }

  /**
   * "Open in panel": remembered, and handed on.
   * @param {Event} e
   */
  #onPopout(e) {
    e.stopPropagation();
    const { state } = /** @type {CustomEvent<{ state: SearchDialogState }>} */ (e).detail;
    this.#record(state.query);
    this.#emit('acp-search-popout', { state });
  }

  /** @param {string} query */
  #record(query) {
    const project = this.#project.value?.path;
    if (project) addRecentSearch(project, query);
  }

  /** @param {Event} e */
  #onPrefs(e) {
    e.stopPropagation();
    setSearchDialogPrefs(/** @type {CustomEvent<{ patch: Partial<SearchDialogPrefs> }>} */ (e).detail.patch);
  }

  render() {
    return html`<acp-search-dialog
      .hasProject=${this.#rootId.value !== null}
      .results=${this.#search.results}
      .searching=${this.#search.searching}
      .limitHit=${this.#search.limitHit}
      .error=${this.#search.error}
      .errorSource=${this.#search.errorSource}
      .recent=${this.#savedSearch?.recent ?? []}
      .folders=${this.folders}
      .foldersQuery=${this.foldersQuery}
      .previewPosition=${this.#prefs.value.preview}
      .view=${this.#prefs.value.view}
      @acp-search-dialog-query=${this.#onQuery}
      @acp-search-dialog-close=${this.#onClose}
      @acp-search-dialog-folders=${this.#onFolders}
      @acp-search-dialog-open=${this.#onOpen}
      @acp-search-dialog-popout=${this.#onPopout}
      @acp-search-dialog-prefs=${this.#onPrefs}
    ></acp-search-dialog>`;
  }
}

customElements.define('acp-search-view', AcpSearchView);
