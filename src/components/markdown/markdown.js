import { LitElement, html } from 'lit';
import { markdown } from '../../hooks/markdown/markdown.js';
import '@symblight/chat/composer';
import styles from './markdown.css?inline';

/** @typedef {import('../../hooks/markdown/types.js').LinkTarget} LinkTarget */

/**
 * @tag acp-markdown
 * @summary Markdown (an agent's reply) rendered safely: sanitized HTML, fenced code in `<chx-code-block>`, web links opened in the browser (others left to the host); re-rendered at most once a frame while it streams.
 * @fires acp-link-open `{ url }` A web or mail link, for the browser.
 */
export class AcpMarkdown extends LitElement {
  static properties = {
    text: { type: String },
    streaming: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** @type {((root: ParentNode) => void) | null} Rewrites the rendered nodes before they're styled (file refs into chips). */
  decorate = null;

  /** Pending repaint; text streaming in many deltas a frame is parsed once. */
  #frame = 0;
  /** @type {string | null} The text the body shows. */
  #painted = null;
  /** @type {{ raw: string, node: Node }[]} The body's top-level blocks, by their source. */
  #blocks = [];
  /** @type {Map<HTMLAnchorElement, LinkTarget>} Where the links in the body lead. */
  #links = new Map();

  constructor() {
    super();
    /** @type {string} */
    this.text = '';
    /** @type {boolean} The reply is still arriving: the last code block may be unfinished. */
    this.streaming = false;
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    super.disconnectedCallback();
  }

  updated() {
    if (this.#painted === this.text || this.#frame) return;
    // The first paint is immediate, so a restored message doesn't flash empty.
    if (this.#painted === null) this.#paint();
    else this.#frame = requestAnimationFrame(() => this.#paint());
  }

  #paint() {
    this.#frame = 0;
    const body = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-markdown__body'));
    if (!body) return;
    this.#painted = this.text;
    const { fragment, blocks, links } = markdown.render(this.text, { policy: 'reply', decorate: this.decorate });
    const kept = this.#show(body, fragment, blocks);
    // Links of the blocks that stayed are still in the body; the rest are the new ones.
    this.#links = new Map([...this.#links, ...links].filter(([link]) => link.isConnected));
    this.#blocks = [...this.#blocks.slice(0, kept), ...blocks.slice(kept)].map(({ raw, node }) => ({ raw, node }));
  }

  /**
   * Puts the render in the body, keeping the nodes of the leading blocks whose source did not change
   * (a keystroke at the end of a long text doesn't rebuild the top). A reference link whose
   * definition changed further down is not redone until its own block is.
   * @param {HTMLElement} body
   * @param {DocumentFragment} fragment
   * @param {{ raw: string, node: Node }[]} blocks
   * @returns {number} How many leading blocks were kept.
   */
  #show(body, fragment, blocks) {
    const before = this.#blocks;
    let kept = 0;
    while (kept < before.length && kept < blocks.length && before[kept].raw === blocks[kept].raw) kept++;
    if (kept === 0) {
      body.replaceChildren(fragment);
      return 0;
    }
    const last = before[kept - 1].node;
    while (last.nextSibling) last.nextSibling.remove();
    // The new fragment starts with the blocks already shown.
    const boundary = blocks[kept - 1].node;
    while (fragment.firstChild && fragment.firstChild !== boundary) fragment.firstChild.remove();
    fragment.removeChild(boundary);
    body.append(fragment);
    return kept;
  }

  /** Links open in the browser, not in the app's window. */
  #onClick = (/** @type {MouseEvent} */ e) => {
    const link = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const target = this.#links.get(link);
    if (target?.kind !== 'external') return;
    this.dispatchEvent(new CustomEvent('acp-link-open', { detail: { url: target.target }, bubbles: true, composed: true }));
  };

  render() {
    return html`<div class="acp-markdown__body" @click=${this.#onClick}></div>`;
  }
}

customElements.define('acp-markdown', AcpMarkdown);
