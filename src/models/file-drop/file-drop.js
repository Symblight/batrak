import { relPath } from '../../hooks/projects/rules.js';

/** @typedef {import('../types/types.js').Platform} Platform */
/** @typedef {import('../types/types.js').DroppedEntry} DroppedEntry */
/** @typedef {import('../types/types.js').ChatFile} ChatFile */

/**
 * The innermost element under a point, looking inside open shadow roots.
 * @param {Document | ShadowRoot} root
 * @param {number} x CSS px, from the viewport's left.
 * @param {number} y CSS px, from the viewport's top.
 * @returns {Element | null}
 */
export function deepElementFromPoint(root, x, y) {
  let el = root.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/**
 * The parent of a node, stepping out of a shadow root to its host.
 * @param {Node} node
 * @returns {Node | null}
 */
function composedParent(node) {
  if (node.parentNode instanceof ShadowRoot) return node.parentNode.host;
  return node.parentNode;
}

/**
 * The innermost element matching `selector` that holds the point, across shadow roots.
 * @param {Document | ShadowRoot} root
 * @param {number} x CSS px.
 * @param {number} y CSS px.
 * @param {string} selector The drop targets (`acp-terminal`).
 * @returns {Element | null}
 */
export function dropTargetAt(root, x, y, selector) {
  /** @type {Node | null} */
  let node = deepElementFromPoint(root, x, y);
  for (; node; node = composedParent(node)) {
    if (node instanceof Element && node.matches(selector)) return node;
  }
  return null;
}

/**
 * Whether `node` is `host` or inside it, across shadow roots.
 * @param {Node} host
 * @param {Node} node
 */
export function composedContains(host, node) {
  /** @type {Node | null} */
  let n = node;
  for (; n; n = composedParent(n)) if (n === host) return true;
  return false;
}

/**
 * How many of the webview's drag positions make one CSS px: Windows reports physical pixels, macOS
 * (AppKit points) and Linux (GTK's logical pixels) report logical ones.
 * @param {Platform} platform
 * @param {number} devicePixelRatio
 */
export function osScale(platform, devicePixelRatio) {
  return platform === 'windows' ? devicePixelRatio : 1;
}

/**
 * A drag position from the webview in CSS px.
 * @param {{ x: number, y: number }} position
 * @param {Platform} platform
 * @param {number} devicePixelRatio
 */
export function toCssPoint({ x, y }, platform, devicePixelRatio) {
  const scale = osScale(platform, devicePixelRatio);
  return { x: x / scale, y: y / scale };
}

/**
 * What files dropped on the chat become: chips, an image's too (the agent reads it by its path),
 * relative to the session's folder when inside it, else absolute.
 * @param {readonly DroppedEntry[]} entries
 * @param {string | null} root The active session's folder.
 * @returns {ChatFile[]}
 */
export function chatDropOf(entries, root) {
  return entries
    .filter(({ kind }) => kind !== 'other')
    .map(({ path, kind }) => ({ path: relPath(root, path) ?? path, folder: kind === 'folder' }));
}
