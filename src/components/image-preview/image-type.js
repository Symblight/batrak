/**
 * An image file's format, as the preview names it.
 * @typedef {Object} ImageType
 * @property {string} label `PNG`, `JPEG`, …; the extension upper-cased when unknown, `''` without one.
 * @property {string} mime `''` when unknown.
 */

/** @type {Readonly<Record<string, ImageType>>} By lower-case extension. */
const TYPES = {
  png: { label: 'PNG', mime: 'image/png' },
  jpg: { label: 'JPEG', mime: 'image/jpeg' },
  jpeg: { label: 'JPEG', mime: 'image/jpeg' },
  gif: { label: 'GIF', mime: 'image/gif' },
  webp: { label: 'WebP', mime: 'image/webp' },
  avif: { label: 'AVIF', mime: 'image/avif' },
  bmp: { label: 'BMP', mime: 'image/bmp' },
  ico: { label: 'ICO', mime: 'image/x-icon' },
  svg: { label: 'SVG', mime: 'image/svg+xml' },
};

/**
 * @param {string} path
 * @returns {ImageType} By the file's extension. An SVG needs its MIME type to render from a Blob.
 */
function imageTypeOf(path) {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { label: '', mime: '' };
  const ext = name.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? { label: ext.toUpperCase(), mime: '' };
}

/** An image file's format, from its path. */
export const imageType = Object.freeze({ of: imageTypeOf });
