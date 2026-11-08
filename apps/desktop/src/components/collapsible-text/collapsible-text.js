import { LitElement, html, nothing } from 'lit';
import styles from './collapsible-text.css?inline';

/**
 * @tag acp-collapsible-text
 * @summary Its content folded to its last lines while it's longer; a click or Enter unfolds it into a taller box that scrolls.
 */
export class AcpCollapsibleText extends LitElement {
  static properties = {
    expanded: { type: Boolean, reflect: true },
    overflowing: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** Reads whether the folded content hides some, as it's laid out and resized. */
  #observer = new ResizeObserver(() => this.#measure());

  constructor() {
    super();
    /** @type {boolean} Unfolded by the user. */
    this.expanded = false;
    /** @type {boolean} Folded, the content is taller than the box. */
    this.overflowing = false;
  }

  get #box() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-collapsible-text__box'));
  }

  firstUpdated() {
    const box = this.#box;
    const content = this.renderRoot.querySelector('.acp-collapsible-text__content');
    if (box) this.#observer.observe(box);
    if (content) this.#observer.observe(content);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#observer.disconnect();
  }

  /** The folded box clips its content's start, which `scrollHeight` doesn't count: the content's own height does. */
  #measure() {
    const box = this.#box;
    const content = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-collapsible-text__content'));
    if (box && content && !this.expanded) this.overflowing = content.offsetHeight > box.clientHeight + 1;
  }

  get #folded() {
    return this.overflowing && !this.expanded;
  }

  #unfold = () => {
    if (this.#folded) this.expanded = true;
  };

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (!this.#folded || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    this.expanded = true;
  };

  render() {
    const foldable = this.overflowing || this.expanded;
    return html`<div
      class="acp-collapsible-text__box"
      role=${this.#folded ? 'button' : nothing}
      tabindex=${this.#folded ? '0' : nothing}
      aria-expanded=${foldable ? String(this.expanded) : nothing}
      @click=${this.#unfold}
      @keydown=${this.#onKeydown}
    >
      <div class="acp-collapsible-text__content"><slot></slot></div>
    </div>`;
  }
}

customElements.define('acp-collapsible-text', AcpCollapsibleText);
