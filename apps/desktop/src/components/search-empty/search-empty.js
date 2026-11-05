import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import noResultsIcon from '@material-design-icons/svg/outlined/search_off.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import styles from './search-empty.css?inline';

/**
 * @tag acp-search-empty
 * @summary Why a search shows no list: an error, or nothing found, with a way to try again.
 * @fires acp-search-empty-action `{ action }` `'plain-text'` (search a bad regex as text) or `'whole-project'` (drop the filters)
 */
export class AcpSearchEmpty extends LitElement {
  static properties = {
    error: { type: String },
    invalidQuery: { type: Boolean, attribute: 'invalid-query' },
    offerPlainText: { type: Boolean, attribute: 'offer-plain-text' },
    query: { type: String },
    where: { type: String },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} The search's error; with none, nothing was found. */
    this.error = '';
    /** @type {boolean} The error is the query's own (a bad regular expression). */
    this.invalidQuery = false;
    /** @type {boolean} Offer to search the query as plain text. */
    this.offerPlainText = false;
    /** @type {string} The query nothing was found for. */
    this.query = '';
    /** @type {string} The folder and mask it was limited to; offers to drop them. */
    this.where = '';
  }

  /** @param {'plain-text' | 'whole-project'} action */
  #act(action) {
    this.dispatchEvent(new CustomEvent('acp-search-empty-action', { detail: { action }, bubbles: true, composed: true }));
  }

  /**
   * @param {string} label
   * @param {'plain-text' | 'whole-project'} action
   */
  #renderAction(label, action) {
    return html`<md-button class="acp-search-empty__action" variant="text" @click=${() => this.#act(action)}>${label}</md-button>`;
  }

  render() {
    if (this.error) {
      return html`<md-icon class="acp-search-empty__icon">${unsafeSVG(errorIcon)}</md-icon>
        ${this.invalidQuery ? html`<p class="acp-search-empty__title">Invalid regular expression</p>` : nothing}
        <p class="acp-search-empty__text">${this.error}</p>
        ${this.invalidQuery && this.offerPlainText ? this.#renderAction('Search as plain text', 'plain-text') : nothing}`;
    }
    return html`<md-icon class="acp-search-empty__icon">${unsafeSVG(noResultsIcon)}</md-icon>
      <p class="acp-search-empty__title">No results for <code class="acp-search-empty__code">${this.query}</code></p>
      ${this.where ? html`<p class="acp-search-empty__text">${this.where}</p>${this.#renderAction('Search the whole project', 'whole-project')}` : nothing}`;
  }
}

customElements.define('acp-search-empty', AcpSearchEmpty);
