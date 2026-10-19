import { LitElement, html, nothing } from 'lit';
import styles from './acp-quick-open.css?inline';

/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */

/**
 * A palette row. `run` is called on Enter / click.
 * @typedef {{ key: string, label: unknown, detail?: unknown, run: () => void }} PaletteItem
 */

/**
 * Palette modes, picked by the query's first character (as in VS Code).
 * No prefix searches files.
 * @typedef {{ prefix: string, title: string, soon?: boolean }} PaletteMode
 */

/** @type {PaletteMode[]} */
const MODES = [
  { prefix: ':', title: 'Go to line' },
  { prefix: '@', title: 'Go to symbol in file', soon: true },
  { prefix: '#', title: 'Go to symbol in workspace', soon: true },
  { prefix: '>', title: 'Commands', soon: true },
];

/**
 * @param {string} text
 * @param {Set<number>} hits Code point indices to highlight.
 * @param {number} offset Index of `text`'s first code point within the full path.
 */
function highlight(text, hits, offset) {
  return Array.from(text).map((ch, i) =>
    hits.has(offset + i) ? html`<span class="acp-quick-open__hit">${ch}</span>` : ch,
  );
}

/**
 * @tag acp-quick-open
 * @summary Quick Open palette (Cmd/Ctrl+P): files, and `:` for Go to line.
 * @fires acp-quick-open-query `{ query }` Files to search for; `null` drops the search (closed, or a mode).
 * @fires acp-quick-open-pick `{ path }` Root-relative file picked.
 * @fires acp-go-to-line `{ line }`
 */
export class AcpQuickOpen extends LitElement {
  static properties = {
    /** Whether a file is open in the editor (`:` needs one). */
    hasOpenFile: { type: Boolean },
    /** Whether a project is open, so there are files to search. */
    hasProject: { type: Boolean },
    /** Matches for the last `acp-quick-open-query`. */
    files: { attribute: false },
    query: { state: true },
    selected: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {boolean} */
    this.hasOpenFile = false;
    /** @type {boolean} */
    this.hasProject = false;
    /** @type {string} */
    this.query = '';
    /** @type {QuickOpenItem[]} */
    this.files = [];
    /** @type {number} */
    this.selected = 0;
  }

  /** @returns {HTMLDialogElement | null} */
  get #dialog() {
    return this.renderRoot?.querySelector('dialog') ?? null;
  }

  /** @returns {PaletteMode | undefined} */
  get #mode() {
    return MODES.find((m) => this.query.startsWith(m.prefix));
  }

  /**
   * Opens the palette.
   * @param {string} [prefix] Initial query, e.g. ':' for Go to line.
   */
  async show(prefix = '') {
    this.query = prefix;
    /** @type {number} */
    this.selected = 0;
    this.files = [];
    await this.updateComplete;
    const dialog = this.#dialog;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const input = /** @type {HTMLInputElement} */ (dialog.querySelector('input'));
    input.value = prefix;
    input.focus();
    this.#queryFiles();
  }

  /** Closes the palette. */
  close() {
    this.#dialog?.close();
  }

  willUpdate(/** @type {Map<string, unknown>} */ changed) {
    if (changed.has('files')) this.selected = 0;
  }

  /** Dialog closed by any means: drop in-flight answers and reset. */
  #onClose() {
    /** @type {string} */
    this.query = '';
    this.files = [];
    this.#query(null);
  }

  /** Searches files for the current query, unless a mode prefix is active. */
  #queryFiles() {
    if (this.#mode || !this.hasProject) {
      this.files = [];
      this.#query(null);
    } else {
      this.#query(this.query);
    }
  }

  /** @param {string | null} query */
  #query(query) {
    this.dispatchEvent(new CustomEvent('acp-quick-open-query', { detail: { query }, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onInput(e) {
    this.query = /** @type {HTMLInputElement} */ (e.target).value;
    this.selected = 0;
    this.#queryFiles();
  }

  /** @returns {PaletteItem[]} */
  #items() {
    const mode = this.#mode;
    if (!mode) return this.files.map((f) => this.#fileItem(f));
    if (mode.soon || !this.hasOpenFile) return [];
    const line = Number.parseInt(this.query.slice(1), 10);
    if (!(line > 0)) return [];
    return [
      {
        key: 'line',
        label: `Go to line ${line}`,
        run: () => this.#emit('acp-go-to-line', { line }),
      },
    ];
  }

  /**
   * @param {QuickOpenItem} file
   * @returns {PaletteItem}
   */
  #fileItem(file) {
    const hits = new Set(file.indices);
    const pathChars = Array.from(file.path).length;
    const nameStart = pathChars - Array.from(file.name).length;
    const dir = nameStart > 0 ? file.path.slice(0, file.path.length - file.name.length - 1) : '';
    return {
      key: file.path,
      label: highlight(file.name, hits, nameStart),
      detail: dir ? highlight(dir, hits, 0) : nothing,
      run: () => this.#emit('acp-quick-open-pick', { path: file.path }),
    };
  }

  /** Text shown instead of an empty list. */
  #message() {
    const mode = this.#mode;
    if (!this.hasProject) return 'Open a project first';
    if (mode?.soon) return `${mode.title}: coming soon`;
    if (mode) return this.hasOpenFile ? 'Type a line number, e.g. :42' : 'Open a file first';
    if (this.query.trim() === '') return 'Type to search files by name';
    return 'No matching files';
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.close();
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {KeyboardEvent} e */
  #onKeydown(e) {
    const items = this.#items();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.selected = (this.selected + step + items.length) % items.length;
      this.updateComplete.then(() =>
        this.renderRoot.querySelector('.acp-quick-open__item_selected')?.scrollIntoView({ block: 'nearest' }),
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[this.selected]?.run();
    }
  }

  render() {
    const items = this.#items();
    return html`
      <dialog class="acp-quick-open__dialog" @close=${this.#onClose}>
        <input
          class="acp-quick-open__input"
          placeholder="Search files by name (: line, @ symbol, # workspace symbol, > command)"
          spellcheck="false"
          autocomplete="off"
          @input=${this.#onInput}
          @keydown=${this.#onKeydown}
        />
        ${items.length === 0
          ? html`<div class="acp-quick-open__message">${this.#message()}</div>`
          : html`<ul class="acp-quick-open__list" role="listbox">
              ${items.map(
                (item, i) => html`<li
                  class="acp-quick-open__item ${i === this.selected ? 'acp-quick-open__item_selected' : ''}"
                  role="option"
                  aria-selected=${i === this.selected}
                  @click=${item.run}
                  @mousemove=${() => {
                    this.selected = i;
                  }}
                >
                  <span>${item.label}</span>
                  <span class="acp-quick-open__detail">${item.detail ?? nothing}</span>
                </li>`,
              )}
            </ul>`}
      </dialog>
    `;
  }
}

customElements.define('acp-quick-open', AcpQuickOpen);
