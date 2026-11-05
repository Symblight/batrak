/**
 * Comma-separated globs; commas inside `{…}` or a `[…]` class don't split. Trimmed, empties dropped.
 * @param {string} text
 * @returns {string[]}
 */
export function splitPatterns(text) {
  const chars = [...text];
  /** @type {string[]} */
  const patterns = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === '[') {
      const close = classEnd(chars, i);
      if (close !== -1) {
        current += chars.slice(i, close + 1).join('');
        i = close;
        continue;
      }
    }
    if (char === '{') depth++;
    else if (char === '}' && depth > 0) depth--;
    if (char === ',' && depth === 0) {
      patterns.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  patterns.push(current);
  return patterns.map((p) => p.trim()).filter(Boolean);
}

/**
 * Index of the `]` closing the class opened at `open`, or -1; a `]` right after `[` or `[!` is literal.
 * @param {string[]} chars
 * @param {number} open
 */
function classEnd(chars, open) {
  let i = open + 1;
  if (chars[i] === '!') i++;
  if (chars[i] === ']') i++;
  return chars.indexOf(']', i);
}

/**
 * A folder name as a glob that matches it literally: each glob character (and the list's comma)
 * becomes a one-character class.
 * @param {string} path
 */
function escapeGlob(path) {
  return path.replace(/[*?[\]{},]/g, (c) => `[${c}]`);
}

/** @param {string} pattern */
const stripDotSlash = (pattern) => pattern.replace(/^(?:\.\/)+/, '');

/**
 * Find in Files' include / exclude globs for a folder filter and a file mask. A pattern without `/`
 * matches a name at any depth; with `/`, the path from the folder (includes) or the root (excludes).
 * Includes are inside the folder; with none, the folder alone is the include.
 * @param {string} folder Root-relative, `''` for the whole project.
 * @param {string} mask Comma-separated globs, a leading `!` excludes.
 * @returns {{ include: string, exclude: string }} Comma-separated.
 */
export function searchFilters(folder, mask) {
  const base = escapeGlob(folder.replace(/\/+$/, ''));
  /** @type {string[]} */
  const include = [];
  /** @type {string[]} */
  const exclude = [];
  for (const pattern of splitPatterns(mask)) {
    if (pattern.startsWith('!')) {
      const glob = stripDotSlash(pattern.slice(1).trim());
      if (glob) exclude.push(glob.includes('/') ? glob : `**/${glob}`);
    } else {
      const stripped = stripDotSlash(pattern);
      if (!stripped) continue;
      const glob = stripped.includes('/') ? stripped : `**/${stripped}`;
      include.push(base ? `${base}/${glob}` : glob);
    }
  }
  if (!include.length && base) include.push(base);
  return { include: include.join(', '), exclude: exclude.join(', ') };
}

/**
 * Where a search looks, for "No results" ("in src/components, *.ts"); `''` without filters.
 * @param {string} folder
 * @param {string} mask
 */
export function filterLabel(folder, mask) {
  const parts = [];
  if (folder) parts.push(`in ${folder}`);
  const patterns = splitPatterns(mask);
  if (patterns.length) parts.push(patterns.join(', '));
  return parts.join(', ');
}
