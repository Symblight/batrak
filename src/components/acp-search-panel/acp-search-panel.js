import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { repeat } from 'lit/directives/repeat.js';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import caseIcon from '@material-design-icons/svg/outlined/text_fields.svg?raw';
import wordIcon from '@material-design-icons/svg/outlined/abc.svg?raw';
import regexIcon from '@material-design-icons/svg/outlined/emergency.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import collapsedIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import { fileIconFor } from '../../models/file-icons.js';
import { absPath } from '../../models/paths.js';
import styles from './acp-search-panel.css?inline';

/** @typedef {import('../../models/types.js').LineMatch} LineMatch */
/** @typedef {import('../../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types.js').SearchFileResult} FileResult */

/** Typing pause before a search starts. */
const DEBOUNCE_MS = 250;
/** Must match `workspace::search::MAX_MATCHES`. */
const MAX_MATCHES = 2000;

/**
 * Splits a line into plain and highlighted parts.
 * @param {string} text
 * @param {[number, number][]} ranges UTF-16 `[start, end)`, ascending.
 */
function highlight(text, ranges) {
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    parts.push(text.slice(at, start));
    parts.push(html`<mark class="acp-search-panel__hit">${text.slice(start, end)}</mark>`);
    at = end;
  }
  parts.push(text.slice(at));
  return parts;
}

/**
 * @tag acp-search-panel
 * @summary Find in Files: the query, its options and filters, and the results by file.
 * @fires acp-search `{ options, delay }` Search for `options` after `delay` ms (typing pauses first).
 * @fires acp-file-open `{ path, line }` when a match is clicked
 */
export class AcpSearchPanel extends LitElement {
  static properties = {
    root: { attribute: false },
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
    collapsed: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string | null} The project's path. */
    this.root = null;
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
    /** @type {Set<string>} Paths of collapsed file groups. */
    this.collapsed = new Set();
  }

  /** Focuses the query input and selects its text. */
  focusInput() {
    const field = this.renderRoot.querySelector('md-text-field');
    if (!field) return;
    field.focus();
    if (field.inputOrTextArea instanceof HTMLInputElement) field.inputOrTextArea.select();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    // A new search starts with no results: its groups start expanded.
    if (changed.has('results') && this.results.length === 0) this.collapsed = new Set();
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

  /**
   * @param {'caseSensitive' | 'wholeWord' | 'regex'} option
   */
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

  /** @param {string} path */
  #toggleFile(path) {
    const collapsed = new Set(this.collapsed);
    if (!collapsed.delete(path)) collapsed.add(path);
    this.collapsed = collapsed;
  }

  /**
   * @param {string} rel
   * @param {number} line
   */
  #open(rel, line) {
    this.dispatchEvent(
      new CustomEvent('acp-file-open', {
        detail: { path: absPath(this.root, rel), line },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Match/file counts, the limit notice, or the error. */
  #renderSummary() {
    if (this.error) return html`<div class="acp-search-panel__summary acp-search-panel__summary_error">${this.error}</div>`;
    if (!this.query) return nothing;
    const count = this.results.reduce((n, r) => n + r.matches.reduce((m, l) => m + l.ranges.length, 0), 0);
    const files = this.results.length;
    const text = this.searching
      ? `Searching… ${count} results in ${files} files`
      : count === 0
        ? 'No results'
        : `${count} results in ${files} files`;
    return html`<div class="acp-search-panel__summary" role="status">
      ${text}${this.limitHit ? ` — showing the first ${MAX_MATCHES}` : ''}
    </div>`;
  }

  /** @param {FileResult} result */
  #renderFile(result) {
    const slash = result.path.lastIndexOf('/');
    const name = result.path.slice(slash + 1);
    const dir = slash > 0 ? result.path.slice(0, slash) : '';
    const collapsed = this.collapsed.has(result.path);
    const count = result.matches.reduce((n, l) => n + l.ranges.length, 0);
    const id = `acp-search-panel-file-${result.path}`;
    return html`<li>
      <button
        id=${id}
        class="acp-search-panel__file-header"
        aria-expanded=${!collapsed}
        @click=${() => this.#toggleFile(result.path)}
      >
        <md-icon class="acp-search-panel__chevron">${unsafeSVG(collapsed ? collapsedIcon : expandIcon)}</md-icon>
        <md-icon class="acp-search-panel__file-icon">${unsafeSVG(fileIconFor(name) ?? fileIcon)}</md-icon>
        <span class="acp-search-panel__file-name">${name}</span>
        <span class="acp-search-panel__file-dir">${dir}</span>
        <span class="acp-search-panel__count">${count}</span>
      </button>
      <md-tooltip for=${id} show-delay="800" style="width: max-content; max-inline-size: none">${result.path}</md-tooltip>
      ${collapsed
        ? nothing
        : html`<ul class="acp-search-panel__matches">
            ${result.matches.map(
              (m) => html`<li>
                <button class="acp-search-panel__match" @click=${() => this.#open(result.path, m.line)}>
                  <span class="acp-search-panel__line">${m.line}</span>
                  <span class="acp-search-panel__text">${highlight(m.text, m.ranges)}</span>
                </button>
              </li>`,
            )}
          </ul>`}
    </li>`;
  }

  /**
   * Icon toggle inside the query field.
   * @param {'caseSensitive' | 'wholeWord' | 'regex'} option
   * @param {string} icon SVG markup.
   * @param {string} label
   */
  #renderOption(option, icon, label) {
    const id = `acp-search-panel-${option}`;
    return html`<md-icon-button
      id=${id}
      class="acp-search-panel__option"
      toggle
      ?selected=${this[option]}
      aria-label=${label}
      aria-pressed=${this[option] ? 'true' : 'false'}
      @click=${() => this.#toggle(option)}
    >
      <md-icon class="acp-search-panel__option-icon">${unsafeSVG(icon)}</md-icon>
    </md-icon-button>
    <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
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
      <div class="acp-search-panel__fields">
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
          <div slot="trailing" class="acp-search-panel__options">
            ${this.#renderOption('caseSensitive', caseIcon, 'Match case')}
            ${this.#renderOption('wholeWord', wordIcon, 'Match whole word')}
            ${this.#renderOption('regex', regexIcon, 'Use regular expression')}
          </div>
        </md-text-field>
        ${this.#renderFilter('include', 'Files to include (src, *.js)')}
        ${this.#renderFilter('exclude', 'Files to exclude')}
      </div>
      ${this.#renderSummary()}
      <ul class="acp-search-panel__results">
        ${repeat(this.results, (r) => r.path, (r) => this.#renderFile(r))}
      </ul>
    `;
  }
}

customElements.define('acp-search-panel', AcpSearchPanel);
