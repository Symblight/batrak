/**
 * @param {string | null} root Absolute path of the project folder.
 * @param {string} rel Path relative to the root.
 * @returns {string} Absolute path.
 */
export function absPath(root, rel) {
  return rel ? `${root}/${rel}` : (root ?? '');
}

/**
 * @param {string | null} root Absolute path of the project folder.
 * @param {string} abs Absolute path inside the root.
 * @returns {string | null} Relative path, or null when outside the root.
 */
export function relPath(root, abs) {
  if (!root) return null;
  const prefix = `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}
