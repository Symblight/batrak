import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/button';
import styles from './collapsible-text.css?inline';

/**
 * @tag acp-collapsible-text
 * @summary Its content folded to its last lines while it's longer; Show more unfolds it into a taller box that scrolls, Show less folds it again.
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

  #toggle = () => {
    this.expanded = !this.expanded;
  };

  render() {
    const foldable = this.overflowing || this.expanded;
    return html`<div class="acp-collapsible-text__box">
        <div class="acp-collapsible-text__content"><slot></slot></div>
      </div>
      ${foldable
        ? html`<md-button class="acp-collapsible-text__toggle" variant="text" aria-expanded=${String(this.expanded)} @click=${this.#toggle}
            >${this.expanded ? 'Show less' : 'Show more'}</md-button
          >`
        : nothing}`;
  }
}

customElements.define('acp-collapsible-text', AcpCollapsibleText);
