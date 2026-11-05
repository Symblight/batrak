import MarkdownIt from 'markdown-it';
import { blockStarts, createSlugger, lineStart } from './blocks.js';
import { classifyUrl, resolveInProject, sanitize } from './policy.js';

/** @typedef {import('./types.js').Rendered} Rendered */
/** @typedef {import('./types.js').RenderOptions} RenderOptions */
/** @typedef {import('./types.js').LinkTarget} LinkTarget */

/** Images read per render; the rest show their alt text. */
const MAX_IMAGES = 200;

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
  IMG: 'acp-markdown__image',
  DETAILS: 'acp-markdown__details',
  SUMMARY: 'acp-markdown__summary',
  KBD: 'acp-markdown__kbd',
};

/** Heading ids start with this, so a file's own markup can't collide with anything. */
const ID_PREFIX = 'acp-md-';

/**
 * GFM task lists: `- [x] text` starts with a checkbox, which the sanitizer then forces disabled.
 * @param {import('markdown-it').StateCore} state
 */
function taskLists({ tokens, Token }) {
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const mark = /^\[([ xX])\]\s+/.exec(inline.content);
    const text = inline.children?.[0];
    if (!mark || text?.type !== 'text' || !text.content.startsWith(mark[0])) continue;
    text.content = text.content.slice(mark[0].length);
    const checkbox = new Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${mark[1] === ' ' ? '' : ' checked'}> `;
    inline.children?.unshift(checkbox);
  }
}

/** @param {import('./types.js').PolicyName} policy */
function createParser(policy) {
  const md = new MarkdownIt({ html: true, linkify: true });
  // `README.md` is not a link, though `.md` is a country's domain.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  md.core.ruler.after('inline', 'task-lists', taskLists);
  if (policy === 'reply') {
    // An image would load as soon as the reply shows, so a reply could send data out in its URL.
    md.renderer.rules.image = (tokens, i) => {
      const href = String(tokens[i].attrGet('src') ?? '');
      return `<a href="${md.utils.escapeHtml(href)}">${md.utils.escapeHtml(tokens[i].content || href)}</a>`;
    };
  }
  return md;
}

/** @type {Record<import('./types.js').PolicyName, import('markdown-it').MarkdownIt>} */
const parsers = { reply: createParser('reply'), document: createParser('document') };

/** @param {Element} el */
const unwrap = (el) => el.replaceWith(...el.childNodes);

/**
 * Links: the web ones to the browser, the relative ones (documents) to a file in the project, `#x` to a heading.
 * @param {DocumentFragment} fragment
 * @param {RenderOptions} options
 */
function collectLinks(fragment, { policy, baseDir = null, root = null }) {
  /** @type {Map<HTMLAnchorElement, LinkTarget>} */
  const links = new Map();
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    const kind = classifyUrl(href);
    if (kind === 'external') {
      links.set(link, { kind: 'external', target: new URL(href.trim()).href });
    } else if (policy !== 'document') {
      continue;
    } else if (kind === 'anchor') {
      let name = href.trim().slice(1);
      try {
        name = decodeURIComponent(name);
      } catch {
        // Left as written.
      }
      links.set(link, { kind: 'anchor', target: ID_PREFIX + name.toLowerCase() });
    } else {
      const target = resolveInProject(href, baseDir, root);
      if (target) links.set(link, { kind: 'file', target: target.path, folder: target.folder, hash: target.hash });
      else unwrap(link);
    }
  }
  return links;
}

/**
 * Images of a document: the ones in the project are listed for the caller to load; they have no `src`
 * until it does. Any other shows its alt text.
 * @param {DocumentFragment} fragment
 * @param {RenderOptions} options
 * @returns {import('./types.js').RenderedImage[]}
 */
function collectImages(fragment, { baseDir = null, root = null }) {
  /** @type {import('./types.js').RenderedImage[]} */
  const images = [];
  for (const img of fragment.querySelectorAll('img')) {
    const target = images.length < MAX_IMAGES ? resolveInProject(img.getAttribute('src') ?? '', baseDir, root) : null;
    if (target === null || target.folder) {
      img.replaceWith(img.getAttribute('alt') ?? '');
      continue;
    }
    img.removeAttribute('src');
    images.push({ node: img, path: target.path });
  }
  return images;
}

/** @param {HTMLPreElement} pre */
function toCodeBlock(pre) {
  const code = pre.querySelector('code');
  const fence = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]?.toLowerCase() ?? '';
  // Made in the fragment's own document: it upgrades, and Lit takes the properties set now, once it is in the page.
  const block = /** @type {import('@symblight/chat/composer').ChxCodeBlock} */ (pre.ownerDocument.createElement('chx-code-block'));
  block.className = 'acp-markdown__code-block';
  block.code = (code?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
  block.lang = LANG_ALIASES[fence] ?? fence;
  block.copyable = true;
  pre.replaceWith(block);
}

/** @param {DocumentFragment} fragment */
function addHeadingIds(fragment) {
  const slugOf = createSlugger();
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const slug = slugOf(heading.textContent ?? '');
    if (slug !== '') heading.id = ID_PREFIX + slug;
  }
}

/**
 * Markdown → a sanitized fragment, in this order: parse, sanitize into an inert document, apply the
 * link and image rules to its nodes, add ids and classes, map the blocks. The caller moves the nodes
 * into the page last; nothing in the fragment has loaded or can until then.
 * @param {string} text
 * @param {RenderOptions} [options]
 * @returns {Rendered}
 * @throws {Error} The sanitizer failed.
 */
function render(text, options = {}) {
  const { policy = 'reply', decorate = null } = options;
  const parser = parsers[policy];
  const env = /** @type {{ references?: Record<string, never> }} */ ({});
  const tokens = parser.parse(text, env);
  const fragment = sanitize(parser.renderer.render(tokens, parser.options, env), policy);

  const links = collectLinks(fragment, { ...options, policy });
  const images = policy === 'document' ? collectImages(fragment, options) : [];
  for (const pre of fragment.querySelectorAll('pre')) toCodeBlock(pre);
  if (policy === 'document') addHeadingIds(fragment);
  decorate?.(fragment);
  for (const element of fragment.querySelectorAll('*')) {
    const name = CLASS_OF[element.tagName];
    if (name) element.className = name;
  }

  const nodes = [...fragment.childNodes].filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''),
  );
  const starts = blockStarts(tokens, text);
  const blocks = nodes.length === starts.length ? starts.map(({ line, raw }, i) => ({ line, raw, node: nodes[i] })) : [];
  return { fragment, blocks, images, links, references: env.references !== undefined };
}

/** Markdown for the app: one function renders it for every surface, from the policy of its source. */
export const markdown = Object.freeze({ render, lineStart });
