import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import historyIcon from '@material-design-icons/svg/outlined/history.svg?raw';
import styles from './search-recent.css?inline';

/**
 * @tag acp-search-recent
 * @summary A project's recent search queries as a list; the host moves the selection.
 * @fires acp-search-recent-pick `{ query }` a query clicked
 */
export class AcpSearchRecent extends LitElement {
  static properties = {
    queries: { attribute: false },
    index: { type: Number },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly string[]} Most recent first. */
    this.queries = [];
    /** @type {number} The selected query. */
    this.index = 0;
  }

  /** @param {string} query */
  #pick(query) {
    this.dispatchEvent(new CustomEvent('acp-search-recent-pick', { detail: { query }, bubbles: true, composed: true }));
  }

  render() {
    return html`<div class="acp-search-recent__heading">Recent searches</div>
      <div class="acp-search-recent__list" role="listbox" aria-label="Recent searches">
        ${this.queries.map(
          (query, i) => html`<div
            class="acp-search-recent__item ${i === this.index ? 'acp-search-recent__item_selected' : ''}"
            role="option"
            aria-selected=${i === this.index ? 'true' : 'false'}
            @click=${() => this.#pick(query)}
          >
            <md-icon class="acp-search-recent__icon">${unsafeSVG(historyIcon)}</md-icon>
            <span class="acp-search-recent__text">${query}</span>
          </div>`,
        )}
      </div>`;
  }
}

customElements.define('acp-search-recent', AcpSearchRecent);
