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

/** A streamed chunk is shown within this many frames of arriving, a share of it each frame. */
const CATCH_UP_FRAMES = 8;
/** How long text that just appeared takes to fade in (`.acp-markdown__fresh` in the CSS). */
const FADE_MS = 160;

/**
 * @tag acp-markdown
 * @summary Markdown rendered safely, by the policy of its source: an agent's reply (no images) or the user's own file (local images, relative links, heading anchors); sanitized HTML, fenced code in `<chx-code-block>`; re-rendered at most once a frame while it streams, only its last blocks, its text revealed at a steady pace and fading in.
 * @fires acp-link-open `{ url }` A web or mail link, for the browser.
 * @fires acp-file-open `{ path }` A link to a file in the project (document).
 * @fires acp-file-reveal `{ path, expand: true }` A link to a folder in the project (document).
 * @fires acp-block-activate `{ line }` A block was double-clicked; its 1-based first line in the text (document).
 * @fires acp-markdown-error `{ error }` The text could not be rendered; the body says so in its place.
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
  /** @type {{ length: number, at: number }[]} The characters each recent paint revealed, newest last, while they fade in. */
  #fresh = [];
  /** The last paint showed less than the text: pacing goes on after the stream ends, until it caught up. */
  #lagging = false;
  /** Characters a paced paint reveals: what was behind when text last arrived, spread over `CATCH_UP_FRAMES`. */
  #step = 0;
  /** The text's length when `#step` was set. */
  #stepFor = 0;
  /** @type {Block[]} The body's top-level blocks. */
  #blocks = [];
  /** The last paint rendered only the end of the text, so what it can't see wasn't applied (reference links). */
  #fromTail = false;
  /** @type {Map<HTMLAnchorElement, LinkTarget>} Where the links in the body lead. */
  #links = new Map();
  /** @type {Map<HTMLImageElement, string>} The object URL of each image shown, freed with its image. */
  #urls = new Map();
  /** Makes the ids of the hints of images that failed to load. */
  #hints = 0;
  /** Images whose bytes are still being read. */
  #reading = 0;

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
    // What was still being read is lost with the element's connection: paint again when it is back.
    if (this.#frame || this.#urls.size || this.#reading) {
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
    const finished = this.#fromTail && !this.streaming;
    if ((this.#painted === this.text && !finished) || this.#frame) return;
    this.#schedule();
  }

  #schedule() {
    // The first paint is immediate, so a restored message doesn't flash empty.
    if (this.#painted === null) this.#paint();
    else this.#frame = requestAnimationFrame(() => this.#paint());
  }

  #paint() {
    this.#frame = 0;
    const body = /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-markdown__body'));
    if (!body) return;
    const text = this.#nextText();
    const settled = this.#settledBlocks(text);
    const line = settled ? this.#blocks[settled].line : 1;
    const source = settled ? text.slice(markdown.lineStart(text, line)) : text;
    const paced = this.#paced;
    const revealed = paced && this.#painted !== null && text.startsWith(this.#painted) ? text.length - this.#painted.length : 0;
    this.#painted = text;
    this.#lagging = paced && text !== this.text;
    /** @type {import('../../hooks/markdown/types.js').Rendered} */
    let rendered;
    try {
      rendered = markdown.render(source, {
        policy: this.policy,
        baseDir: this.baseDir,
        root: this.root,
        decorate: this.decorate,
      });
    } catch (error) {
      this.#showError(body, error);
      return;
    }
    const { fragment, images, links, references } = rendered;
    // Blocks rendered from the end alone may use a reference defined before it.
    if (!settled && this.#fromTail && references) this.#blocks = [];
    this.#fromTail = settled > 0;
    const blocks = rendered.blocks.map((block) => ({ ...block, line: block.line + line - 1 }));
    const kept = this.#show(body, fragment, blocks, settled);
    // Links of the blocks that stayed are still in the body; the rest are the new ones.
    this.#links = new Map([...this.#links, ...links].filter(([link]) => link.isConnected));
    // A kept block keeps its node, but sits where the text now has it.
    this.#blocks = [...this.#blocks.slice(0, settled), ...blocks.map((block, i) => (i < kept ? { ...block, node: this.#blocks[settled + i].node } : block))];
    this.#revokeUnused();
    for (const { node, path } of images) if (node.isConnected) this.#loadInto(node, path);
    if (paced) this.#fadeIn(body, revealed);
    else this.#settleFades(body);
    // caught up after the stream ended: one more paint, whole and plain
    if (text !== this.text || (!this.streaming && (this.#fromTail || paced))) this.#schedule();
  }

  /**
   * What this paint shows: while the text grows at its end, the next share of what arrived, so a
   * chunk appears at a steady pace, all of it within `CATCH_UP_FRAMES`; anything else at once.
   * @returns {string}
   */
  #nextText() {
    const shown = this.#painted;
    if (shown === null || !this.#paced || !this.text.startsWith(shown)) return this.text;
    if (this.text.length !== this.#stepFor) {
      this.#stepFor = this.text.length;
      this.#step = Math.ceil((this.text.length - shown.length) / CATCH_UP_FRAMES);
    }
    let end = shown.length + this.#step;
    // never between the two halves of a surrogate pair
    if (/[\uD800-\uDBFF]/.test(this.text.charAt(end - 1))) end++;
    return this.text.slice(0, end);
  }

  /**
   * The reply's last paint is plain: what was still fading just shows, and the blocks it kept lose
   * their fade wrappers.
   * @param {HTMLElement} body
   */
  #settleFades(body) {
    this.#fresh = [];
    for (const span of body.querySelectorAll('.acp-markdown__fresh')) span.replaceWith(...span.childNodes);
    body.normalize();
  }

  /** A reply arriving, or catching up with what arrived; a document's edits show at once. */
  get #paced() {
    return this.streaming || this.#lagging;
  }

  /**
   * Fades in the text the last paints revealed. Repainted blocks are new nodes, so each paint wraps
   * again the characters still fading, each run's animation set back by its age to go on from
   * where it was. Counted from the end of the rendered text: markdown's own marks make it a
   * character or two off, which a fade can't show.
   * @param {HTMLElement} body
   * @param {number} revealed How many characters this paint added at the end.
   */
  #fadeIn(body, revealed) {
    const now = performance.now();
    if (revealed > 0) this.#fresh.push({ length: revealed, at: now });
    this.#fresh = this.#fresh.filter((run) => now - run.at < FADE_MS);
    if (!this.#fresh.length) return;
    /** @type {Text[]} */
    const texts = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (node.textContent?.trim() && !parent?.closest('.acp-markdown__fresh')) texts.push(/** @type {Text} */ (node));
    }
    for (const run of [...this.#fresh].reverse()) {
      let left = run.length;
      while (left > 0 && texts.length) {
        const node = /** @type {Text} */ (texts.pop());
        const length = node.data.length;
        const tail = length > left ? node.splitText(length - left) : node;
        if (length > left) texts.push(node);
        left -= tail.data.length;
        const span = document.createElement('span');
        span.className = 'acp-markdown__fresh';
        span.style.animationDelay = `${Math.round(run.at - now)}ms`;
        tail.replaceWith(span);
        span.append(tail);
      }
    }
  }

  /**
   * How many leading blocks a paint can leave alone without rendering them: while text only grows
   * at its end, all but the last two. The last can change, and so can the one before it, which it
   * may still join (`1. a\n\n2` is a list and a paragraph, `1. a\n\n2. b` one list).
   */
  /** @param {string} text What this paint shows. */
  #settledBlocks(text) {
    if (!this.#paced || this.#painted === null || !text.startsWith(this.#painted)) return 0;
    return Math.max(0, this.#blocks.length - 2);
  }

  /**
   * The body says the text could not be rendered, and the host is told why.
   * @param {HTMLElement} body
   * @param {unknown} error
   */
  #showError(body, error) {
    const row = document.createElement('p');
    row.className = 'acp-markdown__error';
    row.setAttribute('role', 'alert');
    row.textContent = 'Couldn’t render this text';
    body.replaceChildren(row);
    this.#blocks = [];
    this.#links = new Map();
    this.#revokeUnused();
    this.#emit('acp-markdown-error', { error });
  }

  /**
   * Puts the render in the body, keeping the nodes of the leading blocks whose source did not change
   * (a keystroke at the end of a long text doesn't rebuild the top). A reference link whose
   * definition changed further down is not redone until its own block is.
   * @param {HTMLElement} body
   * @param {DocumentFragment} fragment
   * @param {Block[]} blocks What the fragment holds.
   * @param {number} settled How many leading blocks of the body it doesn't include.
   * @returns {number} How many of its leading blocks were kept.
   */
  #show(body, fragment, blocks, settled) {
    const before = this.#blocks.slice(settled);
    let kept = 0;
    while (kept < before.length && kept < blocks.length && before[kept].raw === blocks[kept].raw) kept++;
    const last = kept ? before[kept - 1].node : this.#blocks[settled - 1]?.node;
    if (!last) {
      body.replaceChildren(fragment);
      return 0;
    }
    while (last.nextSibling) last.nextSibling.remove();
    if (kept) {
      // The new fragment starts with the blocks already shown.
      const boundary = blocks[kept - 1].node;
      while (fragment.firstChild && fragment.firstChild !== boundary) fragment.firstChild.remove();
      fragment.removeChild(boundary);
    }
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
    this.#reading++;
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
    } finally {
      this.#reading--;
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
