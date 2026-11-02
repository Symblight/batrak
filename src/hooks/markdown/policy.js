import createDOMPurify from 'dompurify';

/** @typedef {import('./types.js').PolicyName} PolicyName */
/** @typedef {import('./types.js').LinkKind} LinkKind */

/** Elements of every policy. Anything else goes, with its content. */
const BASE_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
  'em', 'strong', 'del', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
];

/** Formatting wrappers: let through the sanitizer, then unwrapped, so pasted formatting can't carry style. */
const WRAPPERS = ['b', 'i', 'u', 'span', 'div', 'font', 'center'];

/**
 * Per policy: the elements it adds to `BASE_TAGS`.
 * @type {Readonly<Record<PolicyName, readonly string[]>>}
 */
const EXTRA_TAGS = Object.freeze({
  reply: [],
  document: ['img', 'details', 'summary', 'kbd', 'sup', 'sub'],
});

/** The elements no policy lets through, listed so a change to the allowlist can't revive one by accident. */
const NEVER = [
  'style', 'form', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math',
  'picture', 'video', 'audio', 'source', 'track',
];

/**
 * The attributes each element keeps; every other attribute, `on*` and `style` included, is dropped.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const ATTRS = Object.freeze({
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  th: ['align'],
  td: ['align'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start'],
  code: ['class'],
});

const ALL_ATTRS = [...new Set(Object.values(ATTRS).flat())];

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

/**
 * What a link or image address points at. Judged on the parsed `URL`, which is what defeats
 * `jav&#x09;ascript:` (the browser drops the tab), never by a pattern on the string.
 * @param {string} raw As written in the attribute.
 * @returns {LinkKind}
 */
export function classifyUrl(raw) {
  const url = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (url === '') return 'blocked';
  if (url.startsWith('#')) return 'anchor';
  // A network-path reference (`//host/x`) is a web address without its scheme.
  if (/^[\\/]{2}/.test(url)) return 'blocked';
  try {
    return EXTERNAL.has(new URL(url).protocol) ? 'external' : 'blocked';
  } catch {
    return 'relative';
  }
}

/**
 * @param {unknown} result What the sanitizer answered.
 * @returns {DocumentFragment}
 */
export function assertFragment(result) {
  if (!result || typeof result !== 'object' || /** @type {Node} */ (result).nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    throw new Error('The sanitizer returned no document');
  }
  return /** @type {DocumentFragment} */ (result);
}

/** @param {string} value */
const languageClasses = (value) =>
  value
    .split(/\s+/)
    .filter((c) => /^language-[\w+-]+$/.test(c))
    .join(' ');

/** @type {Partial<Record<PolicyName, ReturnType<typeof createDOMPurify>>>} */
const purifiers = {};

/**
 * One instance per policy, apart from the default one the chat's callers share, so the hooks
 * installed here never run for them.
 * @param {PolicyName} policy
 */
function purifierFor(policy) {
  const existing = purifiers[policy];
  if (existing) return existing;
  const purify = createDOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const allowed = ATTRS[node.localName];
    if (!allowed?.includes(data.attrName)) {
      data.keepAttr = false;
      return;
    }
    if (data.attrName !== 'class') return;
    data.attrValue = languageClasses(data.attrValue);
    data.keepAttr = data.attrValue !== '';
  });
  return (purifiers[policy] = purify);
}

/** @param {PolicyName} policy */
function configOf(policy) {
  return {
    // `#text` is a node name to DOMPurify: left out, every text would go with `KEEP_CONTENT` off.
    ALLOWED_TAGS: ['#text', ...BASE_TAGS, ...EXTRA_TAGS[policy], ...WRAPPERS],
    ALLOWED_ATTR: ALL_ATTRS,
    FORBID_TAGS: NEVER,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: false,
    RETURN_DOM_FRAGMENT: /** @type {const} */ (true),
  };
}

/** @param {Element} el */
const unwrap = (el) => el.replaceWith(...el.childNodes);

/** @param {HTMLAnchorElement} link */
function markExternal(link) {
  link.setAttribute('rel', 'noopener noreferrer ugc');
  link.removeAttribute('target');
}

/**
 * The rules that need a look at the parsed address, on the fragment's own nodes.
 * @param {DocumentFragment} fragment
 */
function applyRules(fragment) {
  for (const wrapper of fragment.querySelectorAll(WRAPPERS.join(','))) unwrap(wrapper);

  for (const link of fragment.querySelectorAll('a')) {
    const kind = classifyUrl(link.getAttribute('href') ?? '');
    if (kind === 'blocked') unwrap(link);
    else if (kind === 'external') markExternal(link);
  }

  for (const img of fragment.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    const kind = classifyUrl(src);
    if (kind === 'relative') continue;
    // Never fetched: a web image is a link to where it lives, anything else its description.
    if (kind === 'external' && !src.trim().toLowerCase().startsWith('mailto:')) {
      const link = /** @type {HTMLAnchorElement} */ (img.ownerDocument.createElement('a'));
      link.setAttribute('href', src);
      link.textContent = alt || src;
      markExternal(link);
      img.replaceWith(link);
    } else {
      img.replaceWith(alt);
    }
  }

  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type')?.toLowerCase() !== 'checkbox') input.remove();
    else input.setAttribute('disabled', '');
  }
}

/**
 * Markup → a sanitized fragment of an inert document (no browsing context, so nothing in it loads).
 * Only the allowlist survives; the caller moves the nodes into the page last.
 * @param {string} html
 * @param {PolicyName} policy
 * @returns {DocumentFragment}
 * @throws {Error} The sanitizer failed.
 */
export function sanitize(html, policy) {
  const fragment = assertFragment(purifierFor(policy).sanitize(html, configOf(policy)));
  applyRules(fragment);
  return fragment;
}

/**
 * A link or image target as a path in the project.
 * @typedef {Object} ProjectTarget
 * @property {string} path Absolute, normalized.
 * @property {boolean} folder The target ended in a slash.
 * @property {string} hash The `#fragment`, decoded, without the `#`.
 */

/**
 * Resolves a relative or absolute target against a file's folder. The same containment the backend
 * applies: nothing outside the project, and nothing in `.git`.
 * @param {string} target As written in the markdown, percent-encoded.
 * @param {string | null} baseDir Absolute folder of the file the markdown is from.
 * @param {string | null} root Absolute project folder.
 * @returns {ProjectTarget | null} `null` when it points elsewhere, or can't be read.
 */
export function resolveInProject(target, baseDir, root) {
  if (baseDir === null || root === null) return null;
  const [beforeHash, ...fragment] = target.trim().split('#');
  const pathPart = beforeHash.split('?')[0];
  let decoded;
  let hash;
  try {
    decoded = decodeURIComponent(pathPart);
    hash = decodeURIComponent(fragment.join('#'));
  } catch {
    return null;
  }
  if (decoded === '' || decoded.includes('\0')) return null;

  const rootParts = root.split(/[\\/]+/).filter(Boolean);
  const absolute = /^[\\/]/.test(decoded);
  /** @type {string[]} */
  const parts = [];
  for (const part of (absolute ? decoded : `${baseDir}/${decoded}`).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (parts.length < rootParts.length || !rootParts.every((part, i) => parts[i] === part)) return null;
  if (parts.slice(rootParts.length).some((part) => part.toLowerCase() === '.git')) return null;
  return {
    path: (root.startsWith('/') ? '/' : '') + parts.join('/'),
    folder: /[\\/]$/.test(decoded),
    hash,
  };
}
