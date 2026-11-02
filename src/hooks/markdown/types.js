/** @typedef {'reply' | 'document'} PolicyName Who the markdown is for: an agent's reply, or the user's own file. */

/**
 * What a link in a rendered fragment points at.
 * @typedef {'external' | 'relative' | 'anchor' | 'blocked'} LinkKind
 */

export {};

/**
 * Where a rendered link leads; the caller opens it. `file`'s `target` is an absolute path in the project.
 * @typedef {{ kind: 'external', target: string }
 *   | { kind: 'file', target: string, folder: boolean, hash: string }
 *   | { kind: 'anchor', target: string }} LinkTarget
 */

/**
 * @typedef {Object} RenderedBlock
 * @property {number} line 1-based line of the source where the block begins.
 * @property {Node} node The block's node in the fragment.
 */

/**
 * @typedef {Object} RenderedImage
 * @property {HTMLImageElement} node Without a `src`; the caller sets one once the node is in the page.
 * @property {string} path Absolute path in the project.
 */

/**
 * @typedef {Object} Rendered
 * @property {DocumentFragment} fragment Sanitized, with ids and classes set, in an inert document.
 * @property {RenderedBlock[]} blocks Top-level blocks and their start lines; empty when the nodes can't be matched to the blocks.
 * @property {RenderedImage[]} images
 * @property {Map<HTMLAnchorElement, LinkTarget>} links
 */

/**
 * @typedef {Object} RenderOptions
 * @property {import('./types.js').PolicyName} [policy] Default `reply`.
 * @property {string | null} [baseDir] Absolute folder of the file the markdown is from; relative targets resolve against it.
 * @property {string | null} [root] Absolute project folder; no target leads outside it.
 * @property {((root: ParentNode) => void) | null} [decorate] Rewrites the nodes before the classes are set.
 */
