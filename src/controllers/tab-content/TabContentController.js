/** @typedef {import('../../models/types.js').TabKind} TabKind */
/** @typedef {import('../../models/types.js').ContentKind} ContentKind */

/**
 * What a tab points at, as `parseTabId()` returns it.
 * @typedef {Object} TabTarget
 * @property {TabKind} kind
 * @property {string} path Absolute; `''` for a view.
 */

/**
 * @template {TabTarget} T
 * @typedef {Object} TabContentConfig
 * @property {Record<ContentKind, (tab: T) => unknown>} views Renders a tab's content, one per kind, so
 *   adding a kind fails the typecheck until it has a view.
 */

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
/** @type {ReadonlySet<ContentKind>} Kinds that show the file's text: the tab reads it and its baseline. */
const TEXT = new Set(['code', 'markdown']);

/**
 * @param {TabTarget} tab
 * @returns {ContentKind} A file's by its extension (SVG is an image), a view's by its kind.
 */
export function contentKindOf({ kind, path }) {
  if (kind !== 'file') return kind;
  if (IMAGE.test(path)) return 'image';
  if (MARKDOWN.test(path)) return 'markdown';
  return 'code';
}

/**
 * @param {TabTarget} tab
 * @returns {boolean} Whether the tab's content is the file's text, so the host must read it.
 */
export function readsText(tab) {
  return TEXT.has(contentKindOf(tab));
}

/**
 * @param {TabTarget} tab
 * @returns {boolean} Whether the tab shows the file, as text or as an image, so the host must read it.
 */
export function readsFile(tab) {
  return readsText(tab) || contentKindOf(tab) === 'image';
}

/**
 * Picks which view renders a tab's content and renders it with the host's view for that kind. Has no
 * lifecycle, so it isn't added to the host as a `ReactiveController`.
 * @template {TabTarget} T
 */
export class TabContentController {
  /** @type {TabContentConfig<T>} */
  #config;

  /** @param {TabContentConfig<T>} config */
  constructor(config) {
    this.#config = config;
  }

  /** @param {TabTarget} tab */
  readsText(tab) {
    return readsText(tab);
  }

  /** @param {T} tab */
  render(tab) {
    return this.#config.views[contentKindOf(tab)](tab);
  }
}
