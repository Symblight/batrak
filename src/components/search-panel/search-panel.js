import { search } from '../../hooks/search/search.js';
import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/text-field';
import '../search-options/search-options.js';
import '../search-results/search-results.js';
import styles from './search-panel.css?inline';

/** @typedef {import('../../hooks/search/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../hooks/search/types.js').SearchFileResult} FileResult */
/** @typedef {import('../../hooks/search/types.js').SearchMatchRow} SearchMatchRow */
/** @typedef {import('../../hooks/search/search.js').SearchOptionKey} SearchOptionKey */

/** Typing pause before a search starts. */
const DEBOUNCE_MS = 250;

/**
 * @tag acp-search-panel
 * @summary Find in Files: the query, its options and filters, and the results by file.
 * @fires acp-search `{ options, delay }` Search for `options` after `delay` ms (typing pauses first).
 * @fires acp-search-panel-open `{ path, line, column, length }` when a match is clicked; `path` root-relative
 */
export class AcpSearchPanel extends LitElement {
  static properties = {
    results: { attribute: false },
    searching: { type: Boolean },
    limitHit: { type: Boolean },
    error: { type: String },
    query: { state: true },
    caseSensitive: { state: true },
    wholeWord: { state: true },
    regex: { state: true },
    include: { state: true },
    exclude: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly FileResult[]} */
    this.results = [];
    /** @type {boolean} */
    this.searching = false;
    /** @type {boolean} */
    this.limitHit = false;
    /** @type {string} */
    this.error = '';
    /** @type {string} */
    this.query = '';
    /** @type {boolean} */
    this.caseSensitive = false;
    /** @type {boolean} */
    this.wholeWord = false;
    /** @type {boolean} */
    this.regex = false;
    /** @type {string} */
    this.include = '';
    /** @type {string} */
    this.exclude = '';
  }

  /** Focuses the query input and selects its text. */
  focusInput() {
    const field = this.renderRoot.querySelector('md-text-field');
    if (!field) return;
    field.focus();
    if (field.inputOrTextArea instanceof HTMLInputElement) field.inputOrTextArea.select();
  }

  /**
   * Fills the fields and options (a search handed over from elsewhere) and searches at once.
   * @param {SearchOptions} options
   */
  setOptions(options) {
    ({
      query: this.query,
      caseSensitive: this.caseSensitive,
      wholeWord: this.wholeWord,
      regex: this.regex,
      include: this.include,
      exclude: this.exclude,
    } = options);
    this.#schedule(0);
  }

  /**
   * Searches for the current inputs after `delay` ms.
   * @param {number} delay
   */
  #schedule(delay) {
    /** @type {SearchOptions} */
    const options = {
      query: this.query,
      caseSensitive: this.caseSensitive,
      wholeWord: this.wholeWord,
      regex: this.regex,
      include: this.include,
      exclude: this.exclude,
    };
    this.dispatchEvent(new CustomEvent('acp-search', { detail: { options, delay }, bubbles: true, composed: true }));
  }

  /** @param {SearchOptionKey} option */
  #toggle(option) {
    this[option] = !this[option];
    this.#schedule(0);
  }

  /**
   * @param {'query' | 'include' | 'exclude'} field
   * @param {Event} e
   */
  #onInput(field, e) {
    // Retargeted to <md-text-field>, whose `value` its inner input already updated.
    this[field] = /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value;
    this.#schedule(DEBOUNCE_MS);
  }

  /** @param {KeyboardEvent} e */
  #onKeydown(e) {
    if (e.key === 'Enter') this.#schedule(0);
  }

  /** Alt+C / Alt+W / Alt+R in any field. @param {KeyboardEvent} e */
  #onHostKeydown = (e) => {
    const option = search.optionForKey(e);
    if (!option) return;
    e.preventDefault();
    this.#toggle(option);
  };

  /** @param {Event} e */
  #onOptionToggle(e) {
    e.stopPropagation();
    this.#toggle(/** @type {CustomEvent<{ option: SearchOptionKey }>} */ (e).detail.option);
  }

  /**
   * Re-fires the block's open as the pane's own, so it can't be mistaken for another list's.
   * @param {Event} e
   */
  #onResultOpen(e) {
    e.stopPropagation();
    const { path, line, column, length } = /** @type {CustomEvent<{ row: SearchMatchRow }>} */ (e).detail.row;
    this.dispatchEvent(
      new CustomEvent('acp-search-panel-open', { detail: { path, line, column, length }, bubbles: true, composed: true }),
    );
  }

  /** Match/file counts, the limit notice, or the error. */
  #renderSummary() {
    if (this.error) return html`<div class="acp-search-panel__summary acp-search-panel__summary_error">${this.error}</div>`;
    const text = search.summary({ results: [...this.results], searching: this.searching, error: null, query: this.query });
    if (!text) return nothing;
    return html`<div class="acp-search-panel__summary" role="status">
      ${text}${this.limitHit ? ` — showing the first ${search.maxMatches}` : ''}
    </div>`;
  }

  /**
   * @param {'include' | 'exclude'} field
   * @param {string} placeholder
   */
  #renderFilter(field, placeholder) {
    return html`<md-text-field
      class="acp-search-panel__field"
      variant="outlined"
      placeholder=${placeholder}
      aria-label=${placeholder}
      spellcheck="false"
      .value=${this[field]}
      @input=${(/** @type {Event} */ e) => this.#onInput(field, e)}
      @keydown=${this.#onKeydown}
    ></md-text-field>`;
  }

  render() {
    return html`
      <div class="acp-search-panel__fields" @keydown=${this.#onHostKeydown}>
        <md-text-field
          class="acp-search-panel__field acp-search-panel__field_query"
          variant="outlined"
          placeholder="Search"
          aria-label="Search"
          spellcheck="false"
          .value=${this.query}
          @input=${(/** @type {Event} */ e) => this.#onInput('query', e)}
          @keydown=${this.#onKeydown}
        >
          <acp-search-options
            slot="trailing"
            .caseSensitive=${this.caseSensitive}
            .wholeWord=${this.wholeWord}
            .regex=${this.regex}
            @acp-search-option-toggle=${this.#onOptionToggle}
          ></acp-search-options>
        </md-text-field>
        ${this.#renderFilter('include', 'Files to include (src, *.js)')}
        ${this.#renderFilter('exclude', 'Files to exclude')}
      </div>
      ${this.#renderSummary()}
      <acp-search-results
        class="acp-search-panel__results"
        .results=${this.results}
        .limitHit=${this.limitHit}
        @acp-search-result-open=${this.#onResultOpen}
      ></acp-search-results>
    `;
  }
}

customElements.define('acp-search-panel', AcpSearchPanel);
