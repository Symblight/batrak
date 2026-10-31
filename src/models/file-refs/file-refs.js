import { fileIconFor } from '../file-icons/file-icons.js';

/**
 * A file or folder named in chat text: `@src/app.js`, `src/app.js:12`, `src/app.js:12-23`,
 * `/abs/app.js#L12-L23`, `@src/components/` (a folder ends in a slash).
 * @typedef {Object} FileRef
 * @property {string} path As written: root-relative or absolute, without the `@`, the lines or a folder's slash.
 * @property {boolean} folder
 * @property {number | null} fromLine
 * @property {number | null} toLine
 * @property {boolean} mention Written as `@path`.
 */

/**
 * A run of text, a file ref where `ref` is set.
 * @typedef {{ text: string, ref: FileRef | null }} TextSegment
 */

// A name doesn't end in a dot, so a sentence's full stop stays out.
const SEGMENT = String.raw`\.?[\w@+-](?:[\w.@+-]*[\w@+-])?`;
const PATH = String.raw`(?:\.{1,2}\/|\/)?(?:${SEGMENT}\/)*${SEGMENT}`;
const LINES = String.raw`(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)`;
const WHOLE = new RegExp(String.raw`^(@)?(${PATH})(?:(\/)|${LINES})?$`);
// In running text a ref starts after a space or an opening mark and ends before one, or before
// punctuation that closes a sentence.
const IN_TEXT = new RegExp(String.raw`(^|[\s([{"'“‘])(@)?(${PATH})(?:(\/)|${LINES})?(?=$|[\s)\]}"'”’,;:!?]|\.(?:$|\s))`, 'g');

/**
 * Whether the last segment names a file: an extension with a letter (`app.js`, not `v1.2`), or a
 * dotfile (`.gitignore`).
 * @param {string} name
 */
function isFileName(name) {
  return /^\.[\w-]+$/.test(name) || /[^.]\.[A-Za-z][\w-]*$/.test(name);
}

/**
 * @param {string} at `@` or empty.
 * @param {string} path
 * @param {string} slash `/` after the path (a folder) or empty.
 * @param {(string | undefined)[]} lines The four line captures: `:a-b`, `#La-Lb`.
 * @param {boolean} strict Running text: a bare name (`app.js`) is too likely a word or a domain,
 *   and a folder (`and/or/`) counts only as an `@` mention.
 * @returns {FileRef | null}
 */
function refOf(at, path, slash, lines, strict) {
  if (path.includes('//')) return null;
  if (slash) return strict && !at ? null : { path, folder: true, fromLine: null, toLine: null, mention: Boolean(at) };
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!isFileName(name)) return null;
  const from = lines[0] ?? lines[2];
  const to = lines[1] ?? lines[3];
  const named = path.includes('/') || Boolean(at) || from !== undefined;
  if (strict ? !named : !named && !fileIconFor(name)) return null;
  const fromLine = from === undefined ? null : Number(from);
  return { path, folder: false, fromLine, toLine: to === undefined ? fromLine : Number(to), mention: Boolean(at) };
}

/**
 * The file ref a whole string is (inline code, a link's target), or `null`. A bare name counts
 * only with a known extension (`app.js`, not `this.value`).
 * @param {string} text
 * @returns {FileRef | null}
 */
export function parseFileRef(text) {
  const match = WHOLE.exec(text.trim().replace(/^file:\/\//, ''));
  return match ? refOf(match[1] ?? '', match[2], match[3] ?? '', match.slice(4, 8), false) : null;
}

/**
 * Splits running text around the file refs in it. Only files with a folder, an `@` or lines count,
 * and folders with an `@`.
 * @param {string} text
 * @returns {TextSegment[]}
 */
export function splitFileRefs(text) {
  /** @type {TextSegment[]} */
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    const ref = refOf(match[2] ?? '', match[3], match[4] ?? '', match.slice(5, 9), true);
    if (!ref) continue;
    const start = /** @type {number} */ (match.index) + match[1].length;
    if (start > last) segments.push({ text: text.slice(last, start), ref: null });
    last = /** @type {number} */ (match.index) + match[0].length;
    segments.push({ text: text.slice(start, last), ref });
  }
  if (last < text.length) segments.push({ text: text.slice(last), ref: null });
  return segments;
}

/**
 * A ref's lines as a chip shows them: `12` or `12-23`, empty for none.
 * @param {FileRef} ref
 */
export function linesOf({ fromLine, toLine }) {
  if (fromLine === null) return '';
  return toLine === null || toLine === fromLine ? `${fromLine}` : `${fromLine}-${toLine}`;
}

/**
 * A ref's path made absolute against the project, `.` and `..` resolved: `root/../x` must not pass
 * for a path inside the root.
 * @param {string} path
 * @param {string | null} root
 * @returns {string | null} `null` for a relative path with no project, or one above `/`.
 */
export function absoluteRefPath(path, root) {
  if (!path.startsWith('/') && !root) return null;
  /** @type {string[]} */
  const parts = [];
  for (const segment of (path.startsWith('/') ? path : `${root}/${path}`).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') parts.push(segment);
    else if (parts.pop() === undefined) return null;
  }
  return `/${parts.join('/')}`;
}
