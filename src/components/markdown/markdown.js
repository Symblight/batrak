import { LitElement, html } from 'lit';
import { markdown } from '../../hooks/markdown/markdown.js';
import '@symblight/chat/composer';
import '@symblight/wc-material/tooltip';
import styles from './markdown.css?inline';

/** @typedef {import('../../hooks/markdown/types.js').LinkTarget} LinkTarget */
/** @typedef {import('../../hooks/markdown/types.js').PolicyName} PolicyName */

/**
 * @typedef {Object} Block
 * @property {number} line
 * @property {string} raw
 * @property {Node} node
 */

/**
 * @tag acp-markdown
 * @summary Markdown rendered safely, by the policy of its source: an agent's reply (no images) or the user's own file (local images, relative links, heading anchors); sanitized HTML, fenced code in `<chx-code-block>`; re-rendered at most once a frame while it streams.
 * @fires acp-link-open `{ url }` A web or mail link, for the browser.
 * @fires acp-file-open `{ path }` A link to a file in the project (document).
 * @fires acp-file-reveal `{ path, expand: true }` A link to a folder in the project (document).
 * @fires acp-block-activate `{ line }` A block was double-clicked; its 1-based first line in the text (document).
 */
export class AcpMarkdown extends LitElement {
  static properties = {
    text: { type: String },
    streaming: { type: Boolean, reflect: true },
    policy: { type: String, reflect: true },
    baseDir: { type: String, attribute: 'base-dir' },
    root: { type: String },
    loadImage: { attribute: false },
  };

  static styles = styles;

  /** @type {((root: ParentNode) => void) | null} Rewrites the rendered nodes before they're styled (file refs into chips). */
  decorate = null;

  /** Pending repaint; text streaming in many deltas a frame is parsed once. */
  #frame = 0;
  /** @type {string | null} The text the body shows. */
  #painted = null;
  /** @type {Block[]} The body's top-level blocks. */
  #blocks = [];
  /** @type {Map<HTMLAnchorElement, LinkTarget>} Where the links in the body lead. */
  #links = new Map();
  /** @type {Map<HTMLImageElement, string>} The object URL of each image shown, freed with its image. */
  #urls = new Map();
  /** Makes the ids of the hints of images that failed to load. */
  #hints = 0;

  constructor() {
    super();
    /** @type {string} */
    this.text = '';
    /** @type {boolean} The reply is still arriving: the last code block may be unfinished. */
    this.streaming = false;
    /** @type {PolicyName} `document`: the user's own file. */
    this.policy = 'reply';
    /** @type {string | null} Absolute folder of the file the text is from, which its relative targets resolve against. */
    this.baseDir = null;
    /** @type {string | null} Absolute project folder; no target leads outside it. */
    this.root = null;
    /** @type {((path: string) => Promise<Blob>) | null} Reads a local image's bytes (a `document` only). */
    this.loadImage = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Left unpainted by a disconnect that freed the images: paint again.
    if (this.hasUpdated && this.#painted === null) this.requestUpdate();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#frame);
    if (this.#frame || this.#urls.size) {
      this.#painted = null;
      this.#blocks = [];
    }
    this.#frame = 0;
    this.#revokeUnused(true);
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (this.hasUpdated && (changed.has('policy') || changed.has('baseDir') || changed.has('root'))) {
      this.#painted = null;
      this.#blocks = [];
    }
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
    const { fragment, blocks, images, links } = markdown.render(this.text, {
      policy: this.policy,
      baseDir: this.baseDir,
      root: this.root,
      decorate: this.decorate,
    });
    const kept = this.#show(body, fragment, blocks);
    // Links of the blocks that stayed are still in the body; the rest are the new ones.
    this.#links = new Map([...this.#links, ...links].filter(([link]) => link.isConnected));
    this.#blocks = [...this.#blocks.slice(0, kept), ...blocks.slice(kept)];
    this.#revokeUnused();
    for (const { node, path } of images) if (node.isConnected) this.#loadInto(node, path);
  }

  /**
   * Puts the render in the body, keeping the nodes of the leading blocks whose source did not change
   * (a keystroke at the end of a long text doesn't rebuild the top). A reference link whose
   * definition changed further down is not redone until its own block is.
   * @param {HTMLElement} body
   * @param {DocumentFragment} fragment
   * @param {Block[]} blocks
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

  /**
   * Shows an image from its bytes, which the host reads. The node is in the page by now, so the
   * request is one the host answered, not one the text could make.
   * @param {HTMLImageElement} img
   * @param {string} path
   */
  async #loadInto(img, path) {
    try {
      if (!this.loadImage) throw new Error('');
      const blob = await this.loadImage(path);
      // The block went, or this element did, while the bytes came.
      if (!img.isConnected) return;
      const url = URL.createObjectURL(blob);
      this.#urls.set(img, url);
      img.src = url;
    } catch (err) {
      if (img.isConnected) this.#showBroken(img, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * An image that could not be read: its alt text, and the reason as a hint.
   * @param {HTMLImageElement} img
   * @param {string} reason
   */
  #showBroken(img, reason) {
    const broken = document.createElement('span');
    broken.className = 'acp-markdown__image acp-markdown__image_broken';
    broken.textContent = img.alt;
    const nodes = [broken];
    if (reason) {
      broken.id = `acp-markdown-image-${this.#hints++}`;
      const hint = document.createElement('md-tooltip');
      hint.setAttribute('for', broken.id);
      hint.setAttribute('show-delay', '800');
      hint.textContent = reason;
      nodes.push(hint);
    }
    const block = this.#blocks.find((b) => b.node === img);
    if (block) block.node = broken;
    img.replaceWith(...nodes);
  }

  /**
   * Frees the object URLs of images no longer in the body.
   * @param {boolean} [all] Free every one (the element went away).
   */
  #revokeUnused(all = false) {
    for (const [img, url] of this.#urls) {
      if (!all && img.isConnected) continue;
      URL.revokeObjectURL(url);
      this.#urls.delete(img);
    }
  }

  /** The top-level blocks of what the body shows, by their first line in the text. */
  get blocks() {
    return this.#blocks.map(({ line, node }) => ({ line, node }));
  }

  /** @type {Element | null} The block marked as where the editor is. */
  #marked = null;

  /**
   * Marks one block as the place the editor is at; `null` clears the mark.
   * @param {Node | null} node
   */
  markBlock(node) {
    this.#marked?.classList.remove('acp-markdown__block_current');
    this.#marked = node instanceof Element && node.isConnected ? node : null;
    this.#marked?.classList.add('acp-markdown__block_current');
  }

  /** @param {string} id */
  #scrollToHeading(id) {
    this.renderRoot.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Links open in the browser or in a tab, or scroll to a heading; the app's window never navigates. */
  #onClick = (/** @type {MouseEvent} */ e) => {
    const link = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const target = this.#links.get(link);
    if (!target) return;
    if (target.kind === 'external') this.#emit('acp-link-open', { url: target.target });
    else if (target.kind === 'anchor') this.#scrollToHeading(target.target);
    else if (target.folder) this.#emit('acp-file-reveal', { path: target.target, expand: true });
    else this.#emit('acp-file-open', { path: target.target });
  };

  #onDblClick = (/** @type {MouseEvent} */ e) => {
    if (this.policy !== 'document') return;
    const path = e.composedPath();
    const block = this.#blocks.find((b) => path.includes(b.node));
    if (block) this.#emit('acp-block-activate', { line: block.line });
  };

  render() {
    return html`<div class="acp-markdown__body" @click=${this.#onClick} @dblclick=${this.#onDblClick}></div>`;
  }
}

customElements.define('acp-markdown', AcpMarkdown);
