import { LitElement, html } from 'lit';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import '@symblight/chat/composer';
import styles from './acp-markdown.css?inline';

/** @typedef {import('@symblight/chat/composer').ChxCodeBlock} ChxCodeBlock */

/** Fence info → `chx-code-block` language. */
const LANG_ALIASES = /** @type {Record<string, string>} */ ({
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  rs: 'rust',
  md: 'markdown',
  yml: 'yaml',
  patch: 'diff',
});

/** @param {string} text */
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const markdown = new Marked({
  async: false,
  gfm: true,
  renderer: {
    // An image would load as soon as the reply shows, so a reply could send data out in its URL.
    image({ href, text }) {
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
    },
  },
});

/** Nothing a reply holds is fetched: no media, no `src` of any kind. */
const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'img', 'picture', 'video', 'audio', 'source', 'track'],
  FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background'],
};

/**
 * Class per generated element: the stylesheet names elements by BEM class, never by tag.
 * @type {Record<string, string>}
 */
const CLASS_OF = {
  P: 'acp-markdown__paragraph',
  H1: 'acp-markdown__heading acp-markdown__heading_level-1',
  H2: 'acp-markdown__heading acp-markdown__heading_level-2',
  H3: 'acp-markdown__heading acp-markdown__heading_level-3',
  H4: 'acp-markdown__heading',
  H5: 'acp-markdown__heading',
  H6: 'acp-markdown__heading',
  UL: 'acp-markdown__list',
  OL: 'acp-markdown__list',
  LI: 'acp-markdown__item',
  CODE: 'acp-markdown__code',
  A: 'acp-markdown__link',
  BLOCKQUOTE: 'acp-markdown__quote',
  HR: 'acp-markdown__rule',
  TABLE: 'acp-markdown__table',
  TH: 'acp-markdown__cell acp-markdown__cell_head',
  TD: 'acp-markdown__cell',
  INPUT: 'acp-markdown__checkbox',
};

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

  /** @type {((body: HTMLElement) => void) | null} Rewrites the rendered body before it's styled (file refs into chips). */
  decorate = null;

  /** Pending repaint; text streaming in many deltas a frame is parsed once. */
  #frame = 0;
  /** @type {string | null} The text the body shows. */
  #painted = null;

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
    const parsed = /** @type {string} */ (markdown.parse(this.text));
    body.innerHTML = DOMPurify.sanitize(parsed, SANITIZE);
    for (const pre of body.querySelectorAll('pre')) this.#toCodeBlock(pre);
    this.decorate?.(body);
    for (const element of body.querySelectorAll('*')) {
      const name = CLASS_OF[element.tagName];
      if (name) element.className = name;
    }
  }

  /** @param {HTMLPreElement} pre */
  #toCodeBlock(pre) {
    const code = pre.querySelector('code');
    const fence = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]?.toLowerCase() ?? '';
    const block = /** @type {ChxCodeBlock} */ (document.createElement('chx-code-block'));
    block.className = 'acp-markdown__code-block';
    block.code = (code?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
    block.lang = LANG_ALIASES[fence] ?? fence;
    block.copyable = true;
    pre.replaceWith(block);
  }

  /** Links open in the browser, not in the app's window. */
  #onClick = (/** @type {MouseEvent} */ e) => {
    const link = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (!(link instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    // The scheme as written; the URL as the browser parsed it (quotes and spaces percent-encoded).
    const href = link.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:)/i.test(href)) return;
    this.dispatchEvent(new CustomEvent('acp-link-open', { detail: { url: link.href }, bubbles: true, composed: true }));
  };

  render() {
    return html`<div class="acp-markdown__body" @click=${this.#onClick}></div>`;
  }
}

customElements.define('acp-markdown', AcpMarkdown);
