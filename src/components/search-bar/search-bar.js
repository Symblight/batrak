import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import clearIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import '../search-options/search-options.js';
import styles from './search-bar.css?inline';

/**
 * @tag acp-search-bar
 * @summary The search query field with its clear button and the match options; the host owns the values.
 * @fires acp-search-bar-input `{ value }` the query typed
 * @fires acp-search-bar-clear the clear button pressed
 * @fires acp-search-option-toggle `{ option }` an option toggled (from `<acp-search-options>`)
 */
export class AcpSearchBar extends LitElement {
  static properties = {
    query: { type: String },
    invalid: { type: Boolean, reflect: true },
    expanded: { type: Boolean },
    caseSensitive: { type: Boolean },
    wholeWord: { type: Boolean },
    regex: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.query = '';
    /** @type {boolean} The query is a bad regular expression. */
    this.invalid = false;
    /** @type {boolean} Results or messages are listed for the query (announced to screen readers). */
    this.expanded = false;
    /** @type {boolean} */
    this.caseSensitive = false;
    /** @type {boolean} */
    this.wholeWord = false;
    /** @type {boolean} */
    this.regex = false;
  }

  /** @param {{ select?: boolean }} [options] */
  focusInput({ select = false } = {}) {
    const input = this.renderRoot?.querySelector('input');
    input?.focus();
    if (select) input?.select();
  }

  /** @param {Event} e */
  #onInput(e) {
    this.dispatchEvent(new CustomEvent('acp-search-bar-input', { detail: { value: /** @type {HTMLInputElement} */ (e.target).value }, bubbles: true, composed: true }));
  }

  #clear() {
    this.dispatchEvent(new CustomEvent('acp-search-bar-clear', { bubbles: true, composed: true }));
  }

  render() {
    return html`<md-icon class="acp-search-bar__icon ${this.invalid ? 'acp-search-bar__icon_invalid' : ''}">${unsafeSVG(this.invalid ? errorIcon : searchIcon)}</md-icon>
      <input
        class="acp-search-bar__input"
        role="combobox"
        aria-expanded=${this.expanded ? 'true' : 'false'}
        aria-label="Search"
        aria-invalid=${this.invalid ? 'true' : 'false'}
        placeholder="Search"
        spellcheck="false"
        autocomplete="off"
        .value=${live(this.query)}
        @input=${this.#onInput}
      />
      ${this.query
        ? html`<md-icon-button id="acp-search-bar-clear" class="acp-search-bar__clear" aria-label="Clear" @click=${this.#clear}>
              <md-icon class="acp-search-bar__clear-icon">${unsafeSVG(clearIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-search-bar-clear" show-delay="800">Clear</md-tooltip>`
        : nothing}
      <span class="acp-search-bar__divider"></span>
      <acp-search-options .caseSensitive=${this.caseSensitive} .wholeWord=${this.wholeWord} .regex=${this.regex}></acp-search-options>`;
  }
}

customElements.define('acp-search-bar', AcpSearchBar);
