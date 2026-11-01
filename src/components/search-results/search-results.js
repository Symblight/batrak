import { search } from '../../hooks/search/search.js';
import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { repeat } from 'lit/directives/repeat.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import expandIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import collapsedIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import '../file-icon/file-icon.js';
import styles from './search-results.css?inline';

/** @typedef {import('../../hooks/search/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../hooks/search/types.js').SearchMatchRow} SearchMatchRow */
/** @typedef {{ kind: 'file', key: string, path: string, count: number } | { kind: 'row', key: string, row: SearchMatchRow }} Item */

/** @param {string} path */
function splitPath(path) {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), dir: slash > 0 ? path.slice(0, slash) : '' };
}

/**
 * @tag acp-search-results
 * @summary Find in Files results, one row per match, grouped by file or flat; optionally a listbox with a selection.
 * @fires acp-search-result-select `{ row }` when the selected row changes (selectable only; `row` null when none)
 * @fires acp-search-result-open `{ row }` on a click (a double-click when selectable)
 */
export class AcpSearchResults extends LitElement {
  static properties = {
    results: { attribute: false },
    view: { type: String, reflect: true },
    selectable: { type: Boolean, reflect: true },
    limitHit: { type: Boolean, attribute: 'limit-hit' },
    max: { type: Number },
    collapsed: { state: true },
    selectedKey: { state: true },
  };

  static styles = styles;

  /** @type {SearchMatchRow[]} */
  #rows = [];

  constructor() {
    super();
    /** @type {readonly SearchFileResult[]} */
    this.results = [];
    /** @type {'grouped' | 'flat'} */
    this.view = 'grouped';
    /** @type {boolean} */
    this.selectable = false;
    /** @type {boolean} */
    this.limitHit = false;
    /** @type {number} Characters a row shows; a match past it cuts the line's start. */
    this.max = 60;
    /** @type {Set<string>} Paths of collapsed files. */
    this.collapsed = new Set();
    /** @type {string | null} */
    this.selectedKey = null;
  }

  /** @returns {SearchMatchRow | null} */
  get selectedRow() {
    return this.#rows.find((row) => row.key === this.selectedKey) ?? null;
  }

  /**
   * Moves the selection `step` rows: one step wraps around, longer ones stop at the ends.
   * @param {number} step
   */
  move(step) {
    this.selectedKey = search.moveKey(this.#rows, this.collapsed, this.selectedKey, step);
  }

  /** @param {'first' | 'last'} end */
  moveTo(end) {
    const visible = this.#visible();
    this.selectedKey = (end === 'first' ? visible[0] : visible.at(-1))?.key ?? null;
  }

  #visible() {
    return this.#rows.filter((row) => !this.collapsed.has(row.path));
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('results')) {
      this.#rows = search.matchRows([...this.results]);
      // A new search starts empty: its files start expanded, its first row selected.
      if (this.results.length === 0) {
        this.collapsed = new Set();
        this.selectedKey = null;
      }
    }
    if (this.selectable && !this.selectedRow) this.selectedKey = this.#visible()[0]?.key ?? null;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  updated(changed) {
    if (!this.selectable || !changed.has('selectedKey')) return;
    this.renderRoot.querySelector('.acp-search-results__row_selected')?.scrollIntoView({ block: 'nearest' });
    this.dispatchEvent(
      new CustomEvent('acp-search-result-select', { detail: { row: this.selectedRow }, bubbles: true, composed: true }),
    );
  }

  /** @param {string} path */
  #toggleFile(path) {
    const collapsed = new Set(this.collapsed);
    if (!collapsed.delete(path)) collapsed.add(path);
    const selected = this.selectedRow;
    if (selected && collapsed.has(selected.path)) {
      // The selection leaves the file it was in: the next shown row, else the previous one.
      const at = this.#rows.indexOf(selected);
      const shown = (/** @type {SearchMatchRow} */ row) => !collapsed.has(row.path);
      this.selectedKey = (this.#rows.slice(at).find(shown) ?? this.#rows.slice(0, at).reverse().find(shown))?.key ?? null;
    }
    this.collapsed = collapsed;
  }

  /** @param {SearchMatchRow} row */
  #open(row) {
    this.dispatchEvent(new CustomEvent('acp-search-result-open', { detail: { row }, bubbles: true, composed: true }));
  }

  /** @returns {Item[]} */
  #items() {
    if (this.view === 'flat') return this.#rows.map((row) => ({ kind: 'row', key: row.key, row }));
    /** @type {Item[]} */
    const items = [];
    /** @type {Map<string, Item & { kind: 'file' }>} */
    const files = new Map();
    for (const row of this.#rows) {
      let file = files.get(row.path);
      if (!file) {
        file = { kind: 'file', key: `file:${row.path}`, path: row.path, count: 0 };
        files.set(row.path, file);
        items.push(file);
      }
      file.count++;
      if (!this.collapsed.has(row.path)) items.push({ kind: 'row', key: row.key, row });
    }
    return items;
  }

  /** @param {Item & { kind: 'file' }} item */
  #renderFile({ path, count }) {
    const { name, dir } = splitPath(path);
    const collapsed = this.collapsed.has(path);
    const id = `acp-search-results-file-${path}`;
    return html`<button
        id=${id}
        class="acp-search-results__file"
        tabindex=${this.selectable ? -1 : 0}
        aria-expanded=${!collapsed}
        @click=${() => this.#toggleFile(path)}
      >
        <md-icon class="acp-search-results__chevron">${unsafeSVG(collapsed ? collapsedIcon : expandIcon)}</md-icon>
        <acp-file-icon class="acp-search-results__file-icon" name=${name}></acp-file-icon>
        <span class="acp-search-results__file-name">${name}</span>
        <span class="acp-search-results__file-dir">${dir}</span>
        <span class="acp-search-results__count">${count}</span>
      </button>
      <md-tooltip for=${id} show-delay="800" style="width: max-content; max-inline-size: none">${path}</md-tooltip>`;
  }

  /** @param {SearchMatchRow} row */
  #renderText(row) {
    const clipped = search.clipLine(row.text, row.start, row.end, this.max);
    const parts = search.highlightParts(clipped.text, [[clipped.start, clipped.end]]).map((part) =>
      part.hit ? html`<mark class="acp-search-results__hit">${part.text}</mark>` : part.text,
    );
    return html`<span class="acp-search-results__text">${parts}</span>`;
  }

  /** @param {SearchMatchRow} row */
  #renderRow(row) {
    const flat = this.view === 'flat';
    const locationId = `acp-search-results-location-${row.key}`;
    const content = flat
      ? html`${this.#renderText(row)}<span id=${locationId} class="acp-search-results__location"
            >${splitPath(row.path).name}:${row.line}</span
          >`
      : html`<span class="acp-search-results__line">${row.line}</span>${this.#renderText(row)}`;
    const tooltip = flat
      ? html`<md-tooltip for=${locationId} show-delay="800" style="width: max-content; max-inline-size: none">${row.path}</md-tooltip>`
      : nothing;
    if (!this.selectable) {
      return html`<button class="acp-search-results__row" @click=${() => this.#open(row)}>${content}</button>${tooltip}`;
    }
    const selected = row.key === this.selectedKey;
    return html`<div
        class="acp-search-results__row ${selected ? 'acp-search-results__row_selected' : ''}"
        role="option"
        aria-selected=${selected ? 'true' : 'false'}
        @click=${() => (this.selectedKey = row.key)}
        @dblclick=${() => this.#open(row)}
      >
        ${content}
      </div>
      ${tooltip}`;
  }

  render() {
    return html`<div
      class="acp-search-results__list"
      role=${this.selectable ? 'listbox' : nothing}
      aria-label=${this.selectable ? 'Search results' : nothing}
    >
      ${repeat(
        this.#items(),
        (item) => item.key,
        (item) => (item.kind === 'file' ? this.#renderFile(item) : this.#renderRow(item.row)),
      )}
      ${this.limitHit
        ? html`<div class="acp-search-results__note">
            Showing the first ${search.maxMatches} results. Narrow the search with a folder or a mask.
          </div>`
        : nothing}
    </div>`;
  }
}

customElements.define('acp-search-results', AcpSearchResults);
