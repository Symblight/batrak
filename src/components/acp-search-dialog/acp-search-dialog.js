import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-linear';
import '@symblight/wc-material/tooltip';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import clearIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import previewBelowIcon from '@material-design-icons/svg/outlined/horizontal_split.svg?raw';
import previewRightIcon from '@material-design-icons/svg/outlined/vertical_split.svg?raw';
import popoutIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import groupedIcon from '@material-design-icons/svg/outlined/account_tree.svg?raw';
import flatIcon from '@material-design-icons/svg/outlined/view_list.svg?raw';
import historyIcon from '@material-design-icons/svg/outlined/history.svg?raw';
import noResultsIcon from '@material-design-icons/svg/outlined/search_off.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import '../acp-search-options/acp-search-options.js';
import '../acp-search-results/acp-search-results.js';
import { initialQuery, optionForKey } from '../../models/search.js';
import { filterLabel, searchFilters } from '../../models/search-filter.js';
import { summaryText } from '../../models/search-results.js';
import styles from './acp-search-dialog.css?inline';

/** @typedef {import('../../models/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../models/types.js').SearchMatchRow} SearchMatchRow */
/** @typedef {import('../../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types.js').SearchDialogState} SearchDialogState */
/** @typedef {import('../../models/types.js').SearchDialogPrefs} SearchDialogPrefs */
/** @typedef {import('../../models/types.js').SearchErrorSource} SearchErrorSource */
/** @typedef {import('../../models/search.js').SearchOptionKey} SearchOptionKey */

/** Typing pause before a search starts. */
const DEBOUNCE_MS = 150;
/** Rows PgUp / PgDn move. */
const PAGE = 10;

/** @type {{ value: SearchDialogPrefs['preview'], icon: string, label: string }[]} */
const PREVIEW_POSITIONS = [
  { value: 'bottom', icon: previewBelowIcon, label: 'Preview below' },
  { value: 'right', icon: previewRightIcon, label: 'Preview on the right' },
];

/** @type {{ value: SearchDialogPrefs['view'], icon: string, label: string }[]} */
const VIEWS = [
  { value: 'grouped', icon: groupedIcon, label: 'Group by file' },
  { value: 'flat', icon: flatIcon, label: 'Flat list' },
];

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

  /** @returns {HTMLInputElement | null} */
  get #input() {
    return this.renderRoot?.querySelector('.acp-search-dialog__input') ?? null;
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
      this.query = initialQuery(selection, state.query);
      this.recentIndex = 0;
      this.status = '';
      dialog.showModal();
      await this.updateComplete;
      this.#search(0);
    }
    this.#input?.focus();
    this.#input?.select();
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
    const options = { query, caseSensitive, wholeWord, regex, ...searchFilters(state.folder, state.mask) };
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
      this.close();
      return;
    }
    const option = optionForKey(e);
    if (option) {
      e.preventDefault();
      this.#toggle(option);
    }
  }

  /** The selection keys and Enter, while focus is in the query. @param {KeyboardEvent} e */
  #onInputKeydown(e) {
    if (e.isComposing) return;
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
    this.query = /** @type {HTMLInputElement} */ (e.target).value;
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

  #clear() {
    this.query = '';
    this.recentIndex = 0;
    this.#search(0);
    this.#input?.focus();
  }

  /** @param {string} query */
  #pickRecent(query) {
    this.query = query;
    this.#search(0);
    this.#input?.focus();
  }

  #searchWholeProject() {
    this.folder = '';
    this.mask = '';
    this.#search(0);
  }

  #searchPlainText() {
    this.regex = false;
    this.#search(0);
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

  /** @param {SearchDialogPrefs['preview']} position */
  #setPreview(position) {
    this.#emit('acp-search-dialog-prefs', { patch: { preview: this.previewPosition === position ? 'none' : position } });
  }

  /** @param {SearchDialogPrefs['view']} view */
  #setView(view) {
    if (view !== this.view) this.#emit('acp-search-dialog-prefs', { patch: { view } });
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

  #renderHeader() {
    return html`<div class="acp-search-dialog__header">
      <h2 class="acp-search-dialog__title">Search in files</h2>
      ${PREVIEW_POSITIONS.map(({ value, icon, label }) => {
        const id = `acp-search-dialog-preview-${value}`;
        const pressed = this.previewPosition === value;
        return html`<md-icon-button
            id=${id}
            class="acp-search-dialog__layout-button"
            toggle
            ?selected=${pressed}
            aria-label=${label}
            aria-pressed=${pressed ? 'true' : 'false'}
            @click=${() => this.#setPreview(value)}
          >
            <md-icon class="acp-search-dialog__layout-icon">${unsafeSVG(icon)}</md-icon>
          </md-icon-button>
          <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
      })}
      <md-icon-button
        id="acp-search-dialog-popout"
        class="acp-search-dialog__layout-button"
        aria-label="Open in panel"
        @click=${this.#popout}
      >
        <md-icon class="acp-search-dialog__layout-icon">${unsafeSVG(popoutIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-search-dialog-popout" show-delay="800">Open in panel</md-tooltip>
    </div>`;
  }

  #renderBar() {
    const invalid = Boolean(this.error) && this.errorSource === 'query';
    return html`<div class="acp-search-dialog__bar ${invalid ? 'acp-search-dialog__bar_error' : ''}">
      <md-icon class="acp-search-dialog__search-icon">${unsafeSVG(invalid ? errorIcon : searchIcon)}</md-icon>
      <input
        class="acp-search-dialog__input"
        role="combobox"
        aria-expanded=${this.hasProject && this.query !== '' ? 'true' : 'false'}
        aria-label="Search"
        aria-invalid=${invalid ? 'true' : 'false'}
        placeholder="Search"
        spellcheck="false"
        autocomplete="off"
        .value=${live(this.query)}
        @input=${this.#onInput}
        @keydown=${this.#onInputKeydown}
      />
      ${this.query
        ? html`<md-icon-button id="acp-search-dialog-clear" class="acp-search-dialog__clear" aria-label="Clear" @click=${this.#clear}>
              <md-icon class="acp-search-dialog__clear-icon">${unsafeSVG(clearIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-search-dialog-clear" show-delay="800">Clear</md-tooltip>`
        : nothing}
      <span class="acp-search-dialog__divider"></span>
      <acp-search-options
        class="acp-search-dialog__options"
        .caseSensitive=${this.caseSensitive}
        .wholeWord=${this.wholeWord}
        .regex=${this.regex}
        @acp-search-option-toggle=${this.#onOptionToggle}
      ></acp-search-options>
    </div>`;
  }

  #renderFilters() {
    const summary = this.hasProject
      ? summaryText({ results: [...this.results], searching: this.searching, error: this.error || null, query: this.query })
      : '';
    return html`<div class="acp-search-dialog__filters">
      <span class="acp-search-dialog__summary ${this.error ? 'acp-search-dialog__summary_error' : ''}">${summary}</span>
      <div class="acp-search-dialog__view" role="radiogroup" aria-label="View">
        ${VIEWS.map(({ value, icon, label }) => {
          const id = `acp-search-dialog-view-${value}`;
          const checked = this.view === value;
          return html`<md-icon-button
              id=${id}
              class="acp-search-dialog__view-button"
              toggle
              ?selected=${checked}
              role="radio"
              aria-label=${label}
              aria-checked=${checked ? 'true' : 'false'}
              @click=${() => this.#setView(value)}
            >
              <md-icon class="acp-search-dialog__view-icon">${unsafeSVG(icon)}</md-icon>
            </md-icon-button>
            <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
        })}
      </div>
    </div>`;
  }

  /**
   * A message instead of the list.
   * @param {string} icon
   * @param {unknown} content
   * @param {{ label: string, run: () => void } | null} [action]
   */
  #renderEmpty(icon, content, action = null) {
    return html`<div class="acp-search-dialog__empty">
      <md-icon class="acp-search-dialog__empty-icon">${unsafeSVG(icon)}</md-icon>
      ${content}
      ${action
        ? html`<md-button class="acp-search-dialog__empty-action" variant="text" @click=${action.run}>${action.label}</md-button>`
        : nothing}
    </div>`;
  }

  #renderRecent() {
    return html`<div class="acp-search-dialog__heading">Recent searches</div>
      <div class="acp-search-dialog__recent" role="listbox" aria-label="Recent searches">
        ${this.recent.map(
          (query, i) => html`<div
            class="acp-search-dialog__recent-item ${i === this.recentIndex ? 'acp-search-dialog__recent-item_selected' : ''}"
            role="option"
            aria-selected=${i === this.recentIndex ? 'true' : 'false'}
            @click=${() => this.#pickRecent(query)}
          >
            <md-icon class="acp-search-dialog__recent-icon">${unsafeSVG(historyIcon)}</md-icon>
            <span class="acp-search-dialog__recent-text">${query}</span>
          </div>`,
        )}
      </div>`;
  }

  #renderBody() {
    if (!this.hasProject) return html`<p class="acp-search-dialog__message">Open a project first</p>`;
    if (this.error) {
      const invalid = this.errorSource === 'query';
      return this.#renderEmpty(
        errorIcon,
        html`${invalid ? html`<p class="acp-search-dialog__empty-title">Invalid regular expression</p>` : nothing}
          <p class="acp-search-dialog__empty-text">${this.error}</p>`,
        invalid && this.regex ? { label: 'Search as plain text', run: () => this.#searchPlainText() } : null,
      );
    }
    if (this.query === '') {
      return this.recent.length > 0 ? this.#renderRecent() : html`<p class="acp-search-dialog__message">Type to search in files</p>`;
    }
    if (!this.searching && this.results.length === 0) {
      const where = filterLabel(this.folder, this.mask);
      return this.#renderEmpty(
        noResultsIcon,
        html`<p class="acp-search-dialog__empty-title">No results for <code class="acp-search-dialog__code">${this.query}</code></p>
          ${where ? html`<p class="acp-search-dialog__empty-text">${where}</p>` : nothing}`,
        where ? { label: 'Search the whole project', run: () => this.#searchWholeProject() } : null,
      );
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
        ${this.#renderHeader()} ${this.#renderBar()}
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
