/**
 * @param {string | null} root Absolute path of the project folder.
 * @param {string} rel Path relative to the root.
 * @returns {string} Absolute path.
 */
export function absPath(root, rel) {
  return rel ? `${root}/${rel}` : (root ?? '');
}

/**
 * The worktree session folder a path lies in.
 * @param {readonly import('../types/types.js').WorktreeFolder[]} worktrees
 * @param {string} abs Absolute path.
 */
export function worktreeOf(worktrees, abs) {
  return worktrees.find((w) => abs.startsWith(`${w.folder}/`)) ?? null;
}

/**
 * A path in a worktree session's folder as the same path in its project; any other as it is.
 * @param {readonly import('../types/types.js').WorktreeFolder[]} worktrees
 * @param {string} abs Absolute path.
 */
export function projectPathOf(worktrees, abs) {
  const worktree = worktreeOf(worktrees, abs);
  return worktree ? absPath(worktree.projectId, relPath(worktree.folder, abs) ?? '') : abs;
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

/**
 * @param {string} path
 * @returns {boolean} Whether it's absolute: `/…`, `C:\…` or a Windows UNC path.
 */
export function isAbsolute(path) {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);
}

/**
 * @param {string} path
 * @returns {string} Its last segment.
 */
export function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * A file's path as tabs show it: relative to the project, or to its worktree session's folder;
 * absolute outside both.
 * @param {string | null} root Absolute path of the project folder.
 * @param {readonly import('../types/types.js').WorktreeFolder[]} worktrees
 * @param {string} abs Absolute path.
 */
export function shownPath(root, worktrees, abs) {
  const worktree = worktreeOf(worktrees, abs);
  return relPath(worktree ? worktree.folder : root, abs) ?? abs;
}
