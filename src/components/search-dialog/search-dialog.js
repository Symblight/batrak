import { search } from '../../hooks/search/search.js';
import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/progress-linear';
import '../search-bar/search-bar.js';
import '../search-empty/search-empty.js';
import '../search-filters/search-filters.js';
import '../search-header/search-header.js';
import '../search-recent/search-recent.js';
import '../search-results/search-results.js';
import '../search-view-picker/search-view-picker.js';
import styles from './search-dialog.css?inline';

/** @typedef {import('../../hooks/search/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../hooks/search/types.js').SearchMatchRow} SearchMatchRow */
/** @typedef {import('../../hooks/search/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../hooks/search/types.js').SearchDialogPrefs} SearchDialogPrefs */
/** @typedef {import('../../hooks/search/types.js').SearchErrorSource} SearchErrorSource */
/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/search/search.js').SearchOptionKey} SearchOptionKey */

/** Typing pause before a search starts. */
const DEBOUNCE_MS = 150;
/** Rows PgUp / PgDn move. */
const PAGE = 10;

/** The focused element, looking into shadow roots. */
function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/**
 * @tag acp-search-dialog
 * @summary Search in files as a modal dialog: query, options, results and recent searches.
 * @fires acp-search-dialog-query `{ options, state, delay }` Search for `options` after `delay` ms; `state` to save.
 * @fires acp-search-dialog-open `{ path, line, column, length, state }` A match to open (root-relative); the dialog closes.
 * @fires acp-search-dialog-close Closed by any means: the container cancels its search.
 * @fires acp-search-dialog-folders `{ query }` Folders to list in the folder menu (answered through `folders` and `foldersQuery`).
 * @fires acp-search-dialog-popout `{ state }` Hand the search over to the Search pane; the dialog closes.
 * @fires acp-search-dialog-prefs `{ patch }` A layout change to save (`Partial<SearchDialogPrefs>`).
 */
export class AcpSearchDialog extends LitElement {
  static properties = {
    hasProject: { type: Boolean, attribute: 'has-project' },
    results: { attribute: false },
    searching: { type: Boolean },
    limitHit: { type: Boolean, attribute: 'limit-hit' },
    error: { type: String },
    errorSource: { attribute: false },
    recent: { attribute: false },
    folders: { attribute: false },
    foldersQuery: { attribute: false },
    previewPosition: { type: String, reflect: true, attribute: 'preview-position' },
    view: { type: String, reflect: true },
    query: { state: true },
    caseSensitive: { state: true },
    wholeWord: { state: true },
    regex: { state: true },
    folder: { state: true },
    mask: { state: true },
    recentIndex: { state: true },
    status: { state: true },
  };

  static styles = styles;

  /** @type {HTMLElement | null} Focused before the dialog opened; focused again on close. */
  #returnFocus = null;
  /** Whether the last press began on the scrim. */
  #pressedScrim = false;

  constructor() {
    super();
    /** @type {boolean} */
    this.hasProject = false;
    /** @type {readonly SearchFileResult[]} */
    this.results = [];
    /** @type {boolean} */
    this.searching = false;
    /** @type {boolean} */
    this.limitHit = false;
    /** @type {string} */
    this.error = '';
    /** @type {SearchErrorSource | null} */
    this.errorSource = null;
    /** @type {readonly string[]} This project's recent queries, most recent first. */
    this.recent = [];
    /** @type {readonly QuickOpenItem[]} The folder menu's folders, for the last `acp-search-dialog-folders`. */
    this.folders = [];
    /** @type {string | null} The query `folders` answers. */
    this.foldersQuery = null;
    /** @type {SearchDialogPrefs['preview']} */
    this.previewPosition = 'bottom';
    /** @type {SearchDialogPrefs['view']} */
    this.view = 'grouped';
    /** @type {string} */
    this.query = '';
    /** @type {boolean} */
    this.caseSensitive = false;
    /** @type {boolean} */
    this.wholeWord = false;
    /** @type {boolean} */
    this.regex = false;
    /** @type {string} Root-relative, `''` for the whole project. */
    this.folder = '';
    /** @type {string} */
    this.mask = '';
    /** @type {number} The selected recent query, while they are shown. */
    this.recentIndex = 0;
    /** @type {string} The selected row, read out by screen readers. */
    this.status = '';
  }

  get open() {
    return this.#dialog?.open ?? false;
  }

  /** @returns {HTMLDialogElement | null} */
  get #dialog() {
    return this.renderRoot?.querySelector('dialog') ?? null;
  }

  /** @returns {HTMLElementTagNameMap['acp-search-bar'] | null} */
  get #bar() {
    return this.renderRoot?.querySelector('acp-search-bar') ?? null;
  }

  /** @returns {HTMLElementTagNameMap['acp-search-filters'] | null} */
  get #filters() {
    return this.renderRoot?.querySelector('acp-search-filters') ?? null;
  }

  /** @returns {HTMLElementTagNameMap['acp-search-results'] | null} */
  get #results() {
    return this.renderRoot?.querySelector('acp-search-results') ?? null;
  }

  /** @returns {SearchDialogState} */
  get #state() {
    const { query, caseSensitive, wholeWord, regex, folder, mask } = this;
    return { query, caseSensitive, wholeWord, regex, folder, mask };
  }

  get #showsRecent() {
    return this.hasProject && !this.error && this.query === '' && this.recent.length > 0;
  }

  /**
   * Opens with a project's last search and searches it; the query is `selection` when it is one
   * short line. Already open: selects the query.
   * @param {SearchDialogState} state
   * @param {string} [selection] The editor's selected text.
   */
  async show(state, selection) {
    await this.updateComplete;
    const dialog = this.#dialog;
    if (!dialog) return;
    if (!dialog.open) {
      this.#returnFocus = deepActiveElement();
      ({
        caseSensitive: this.caseSensitive,
        wholeWord: this.wholeWord,
        regex: this.regex,
        folder: this.folder,
        mask: this.mask,
      } = state);
      this.query = search.initialQuery(selection, state.query);
      this.recentIndex = 0;
      this.status = '';
      dialog.showModal();
      await this.updateComplete;
      this.#search(0);
    }
    this.#bar?.focusInput({ select: true });
  }

  close() {
    this.#dialog?.close();
  }

  /** @param {number} delay */
  #search(delay) {
    if (!this.hasProject) return;
    const state = this.#state;
    const { query, caseSensitive, wholeWord, regex } = state;
    /** @type {SearchOptions} */
    const options = { query, caseSensitive, wholeWord, regex, ...search.filters(state.folder, state.mask) };
    this.#emit('acp-search-dialog-query', { options, state, delay });
  }

  /**
   * @param {string} type
   * @param {object} [detail]
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #onClose() {
    this.#filters?.closeMenus();
    this.#emit('acp-search-dialog-close');
    const target = this.#returnFocus;
    this.#returnFocus = null;
    if (target?.isConnected) target.focus();
  }

  /** @param {PointerEvent} e */
  #onDialogPointerdown(e) {
    this.#pressedScrim = e.target === this.#dialog;
  }

  /**
   * A click on the scrim lands on the `<dialog>` itself; so does one whose press began inside
   * (a selection dragged out), which must not close it.
   * @param {MouseEvent} e
   */
  #onDialogClick(e) {
    const scrim = this.#pressedScrim && e.target === this.#dialog;
    this.#pressedScrim = false;
    if (scrim) this.close();
  }

  /** Esc and Alt+C / W / R, wherever focus is in the dialog. @param {KeyboardEvent} e */
  #onDialogKeydown(e) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // A menu handles its own Esc; this one comes from outside it (focus still on its chip).
      if (this.#filters?.closeOpenMenu()) this.#bar?.focusInput();
      else this.close();
      return;
    }
    const option = search.optionForKey(e);
    if (option) {
      e.preventDefault();
      this.#toggle(option);
    }
  }

  /** The selection keys and Enter, while focus is in the query. @param {KeyboardEvent} e */
  #onInputKeydown(e) {
    if (e.isComposing || !(e.composedPath()[0] instanceof HTMLInputElement)) return;
    const mod = e.metaKey || e.ctrlKey;
    const recent = this.#showsRecent;
    const results = this.#results;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        if (recent) {
          const n = this.recent.length;
          this.recentIndex = mod ? (step > 0 ? n - 1 : 0) : (this.recentIndex + step + n) % n;
        } else if (mod) results?.moveTo(step > 0 ? 'last' : 'first');
        else results?.move(step);
        break;
      }
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        if (!recent) results?.move(e.key === 'PageDown' ? PAGE : -PAGE);
        break;
      case 'Enter': {
        e.preventDefault();
        if (recent) this.#pickRecent(this.recent[this.recentIndex]);
        else {
          const row = results?.selectedRow;
          if (row) this.#open(row);
        }
        break;
      }
    }
  }

  /** @param {Event} e */
  #onInput(e) {
    e.stopPropagation();
    this.query = /** @type {CustomEvent<{ value: string }>} */ (e).detail.value;
    this.recentIndex = 0;
    this.#search(DEBOUNCE_MS);
  }

  /** @param {SearchOptionKey} option */
  #toggle(option) {
    this[option] = !this[option];
    this.#search(0);
  }

  /** @param {Event} e */
  #onOptionToggle(e) {
    e.stopPropagation();
    this.#toggle(/** @type {CustomEvent<{ option: SearchOptionKey }>} */ (e).detail.option);
  }

  /** @param {Event} e */
  #clear(e) {
    e.stopPropagation();
    this.query = '';
    this.recentIndex = 0;
    this.#search(0);
    this.#bar?.focusInput();
  }

  /** @param {string} query */
  #pickRecent(query) {
    this.query = query;
    this.#search(0);
    this.#bar?.focusInput();
  }

  /** @param {Event} e */
  #onRecentPick(e) {
    e.stopPropagation();
    this.#pickRecent(/** @type {CustomEvent<{ query: string }>} */ (e).detail.query);
  }

  /** @param {Event} e */
  #onEmptyAction(e) {
    e.stopPropagation();
    if (/** @type {CustomEvent<{ action: 'plain-text' | 'whole-project' }>} */ (e).detail.action === 'plain-text') this.regex = false;
    else {
      this.folder = '';
      this.mask = '';
    }
    this.#search(0);
  }

  /** @param {Event} e */
  #onFilterChange(e) {
    e.stopPropagation();
    const { which, value } = /** @type {CustomEvent<{ which: 'folder' | 'mask', value: string }>} */ (e).detail;
    this[which] = value;
    this.#search(0);
  }

  /** @param {Event} e */
  #onFilterFolders(e) {
    e.stopPropagation();
    this.#emit('acp-search-dialog-folders', { query: /** @type {CustomEvent<{ query: string }>} */ (e).detail.query });
  }

  /** @param {Event} e */
  #onFilterLeave(e) {
    e.stopPropagation();
    this.#bar?.focusInput();
  }

  /** @param {SearchMatchRow} row */
  #open({ path, line, column, length }) {
    this.#emit('acp-search-dialog-open', { path, line, column, length, state: this.#state });
    this.#closeToContainer();
  }

  #popout() {
    this.#emit('acp-search-dialog-popout', { state: this.#state });
    this.#closeToContainer();
  }

  /** Closes after handing over: the container focuses the tab or the pane, so focus isn't given back. */
  #closeToContainer() {
    this.#returnFocus = null;
    this.close();
  }

  /** @param {Event} e */
  #onHeaderPreview(e) {
    e.stopPropagation();
    const { position } = /** @type {CustomEvent<{ position: SearchDialogPrefs['preview'] }>} */ (e).detail;
    this.#emit('acp-search-dialog-prefs', { patch: { preview: this.previewPosition === position ? 'none' : position } });
  }

  /** @param {Event} e */
  #onHeaderPopout(e) {
    e.stopPropagation();
    this.#popout();
  }

  /** @param {Event} e */
  #onViewPick(e) {
    e.stopPropagation();
    this.#emit('acp-search-dialog-prefs', { patch: { view: /** @type {CustomEvent<{ view: SearchDialogPrefs['view'] }>} */ (e).detail.view } });
  }

  /** @param {Event} e */
  #onResultOpen(e) {
    e.stopPropagation();
    this.#open(/** @type {CustomEvent<{ row: SearchMatchRow }>} */ (e).detail.row);
  }

  /** @param {Event} e */
  #onResultSelect(e) {
    e.stopPropagation();
    const row = /** @type {CustomEvent<{ row: SearchMatchRow | null }>} */ (e).detail.row;
    this.status = row ? `${row.path.slice(row.path.lastIndexOf('/') + 1)}:${row.line} — ${row.text.trim()}` : '';
  }

  #renderFilters() {
    const summary = this.hasProject
      ? search.summary({ results: [...this.results], searching: this.searching, error: this.error || null, query: this.query })
      : '';
    return html`<div class="acp-search-dialog__filters">
      <acp-search-filters
        .folder=${this.folder}
        .mask=${this.mask}
        .folders=${this.folders}
        .foldersQuery=${this.foldersQuery}
        @acp-search-filter-change=${this.#onFilterChange}
        @acp-search-filter-folders=${this.#onFilterFolders}
        @acp-search-filter-leave=${this.#onFilterLeave}
      ></acp-search-filters>
      <span class="acp-search-dialog__summary ${this.error ? 'acp-search-dialog__summary_error' : ''}">${summary}</span>
      <acp-search-view-picker
        class="acp-search-dialog__view"
        .view=${this.view}
        @acp-search-view-pick=${this.#onViewPick}
      ></acp-search-view-picker>
    </div>`;
  }

  #renderBody() {
    if (!this.hasProject) return html`<p class="acp-search-dialog__message">Open a project first</p>`;
    if (this.error) {
      const invalid = this.errorSource === 'query';
      return html`<acp-search-empty
        class="acp-search-dialog__empty"
        .error=${this.error}
        ?invalid-query=${invalid}
        ?offer-plain-text=${this.regex}
        @acp-search-empty-action=${this.#onEmptyAction}
      ></acp-search-empty>`;
    }
    if (this.query === '') {
      return this.recent.length > 0
        ? html`<acp-search-recent .queries=${this.recent} .index=${this.recentIndex} @acp-search-recent-pick=${this.#onRecentPick}></acp-search-recent>`
        : html`<p class="acp-search-dialog__message">Type to search in files</p>`;
    }
    if (!this.searching && this.results.length === 0) {
      return html`<acp-search-empty
        class="acp-search-dialog__empty"
        .query=${this.query}
        .where=${search.filterLabel(this.folder, this.mask)}
        @acp-search-empty-action=${this.#onEmptyAction}
      ></acp-search-empty>`;
    }
    return html`<acp-search-results
      class="acp-search-dialog__results"
      selectable
      .view=${this.view}
      .results=${this.results}
      .limitHit=${this.limitHit}
      @acp-search-result-open=${this.#onResultOpen}
      @acp-search-result-select=${this.#onResultSelect}
    ></acp-search-results>`;
  }

  render() {
    return html`<dialog
      class="acp-search-dialog__dialog"
      aria-label="Search in files"
      @close=${this.#onClose}
      @pointerdown=${this.#onDialogPointerdown}
      @click=${this.#onDialogClick}
      @keydown=${this.#onDialogKeydown}
    >
      <div class="acp-search-dialog__content">
        <acp-search-header
          .previewPosition=${this.previewPosition}
          @acp-search-header-preview=${this.#onHeaderPreview}
          @acp-search-header-popout=${this.#onHeaderPopout}
        ></acp-search-header>
        <acp-search-bar
          class="acp-search-dialog__bar"
          .query=${this.query}
          ?invalid=${Boolean(this.error) && this.errorSource === 'query'}
          ?expanded=${this.hasProject && this.query !== ''}
          .caseSensitive=${this.caseSensitive}
          .wholeWord=${this.wholeWord}
          .regex=${this.regex}
          @acp-search-bar-input=${this.#onInput}
          @acp-search-bar-clear=${this.#clear}
          @acp-search-option-toggle=${this.#onOptionToggle}
          @keydown=${this.#onInputKeydown}
        ></acp-search-bar>
        ${this.searching ? html`<md-progress-linear class="acp-search-dialog__progress"></md-progress-linear>` : nothing}
        ${this.#renderFilters()}
        <div class="acp-search-dialog__body">${this.#renderBody()}</div>
        <div class="acp-search-dialog__hints">
          <span><kbd class="acp-search-dialog__key">↑↓</kbd> Navigate</span>
          <span><kbd class="acp-search-dialog__key">Enter</kbd> Open</span>
          <span><kbd class="acp-search-dialog__key">Alt+C/W/R</kbd> Options</span>
          <span><kbd class="acp-search-dialog__key">Esc</kbd> Close</span>
        </div>
        <div class="acp-search-dialog__status" aria-live="polite">${this.status}</div>
      </div>
    </dialog>`;
  }
}

customElements.define('acp-search-dialog', AcpSearchDialog);
