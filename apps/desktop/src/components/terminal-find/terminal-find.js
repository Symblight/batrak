import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import upIcon from '@material-design-icons/svg/outlined/keyboard_arrow_up.svg?raw';
import downIcon from '@material-design-icons/svg/outlined/keyboard_arrow_down.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import '../search-bar/search-bar.js';
import styles from './terminal-find.css?inline';

/**
 * @tag acp-terminal-find
 * @summary A terminal's find bar: the query and its options, how many matches, and the buttons to move between them; the host owns the values.
 * @fires acp-terminal-find-step `{ direction }` `next` or `previous`
 * @fires acp-terminal-find-close
 */
export class AcpTerminalFind extends LitElement {
  static properties = {
    query: { type: String },
    invalid: { type: Boolean },
    caseSensitive: { type: Boolean },
    wholeWord: { type: Boolean },
    regex: { type: Boolean },
    result: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.query = '';
    /** @type {boolean} The query is a bad regular expression. */
    this.invalid = false;
    /** @type {boolean} */
    this.caseSensitive = false;
    /** @type {boolean} */
    this.wholeWord = false;
    /** @type {boolean} */
    this.regex = false;
    /** @type {{ index: number, total: number } | null} The current match (0-based, `-1` for none) of how many; `null` until searched. */
    this.result = null;
    this.addEventListener('keydown', this.#onKeydown);
  }

  /**
   * @param {string} type
   * @param {object} [detail]
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Puts the keyboard in the query, what it holds selected. */
  async focusInput() {
    await this.updateComplete;
    const bar = this.renderRoot.querySelector('acp-search-bar');
    await bar?.updateComplete;
    bar?.focusInput({ select: true });
  }

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter') this.#emit('acp-terminal-find-step', { direction: e.shiftKey ? 'previous' : 'next' });
    else if (e.key === 'Escape') this.#emit('acp-terminal-find-close');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  get #count() {
    const { result, query, invalid } = this;
    if (!query || invalid || !result) return '';
    return result.total === 0 ? 'No results' : `${result.index + 1} of ${result.total}`;
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} icon
   * @param {() => void} act
   */
  #renderButton(id, label, icon, act) {
    return html`<md-icon-button id=${id} class="acp-terminal-find__button" aria-label=${label} @click=${act}>
        <md-icon class="acp-terminal-find__icon">${unsafeSVG(icon)}</md-icon>
      </md-icon-button>
      <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
  }

  render() {
    return html`<acp-search-bar
        class="acp-terminal-find__bar"
        .query=${this.query}
        ?invalid=${this.invalid}
        .caseSensitive=${this.caseSensitive}
        .wholeWord=${this.wholeWord}
        .regex=${this.regex}
      ></acp-search-bar>
      <span class="acp-terminal-find__count" role="status">${this.#count}</span>
      ${this.#renderButton('acp-terminal-find-previous', 'Previous match', upIcon, () => this.#emit('acp-terminal-find-step', { direction: 'previous' }))}
      ${this.#renderButton('acp-terminal-find-next', 'Next match', downIcon, () => this.#emit('acp-terminal-find-step', { direction: 'next' }))}
      ${this.#renderButton('acp-terminal-find-close', 'Close', closeIcon, () => this.#emit('acp-terminal-find-close'))}`;
  }
}

customElements.define('acp-terminal-find', AcpTerminalFind);
