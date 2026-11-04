/**
 * @param {string | null} root Absolute path of the project folder.
 * @param {string} rel Path relative to the root.
 * @returns {string} Absolute path.
 */
export function absPath(root, rel) {
  return rel ? `${root}/${rel}` : (root ?? '');
}

/**
 * The workspace folder a path lies in.
 * @param {readonly import('../workspaces/types.js').WorktreeFolder[]} worktrees
 * @param {string} abs Absolute path.
 */
export function worktreeOf(worktrees, abs) {
  return worktrees.find((w) => abs.startsWith(`${w.folder}/`)) ?? null;
}

/**
 * A path in a workspace's folder as the same path in its project; any other as it is.
 * @param {readonly import('../workspaces/types.js').WorktreeFolder[]} worktrees
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
 * A file's path as tabs show it: relative to the project, or to its workspace's folder;
 * absolute outside both.
 * @param {string | null} root Absolute path of the project folder.
 * @param {readonly import('../workspaces/types.js').WorktreeFolder[]} worktrees
 * @param {string} abs Absolute path.
 */
export function shownPath(root, worktrees, abs) {
  const worktree = worktreeOf(worktrees, abs);
  return relPath(worktree ? worktree.folder : root, abs) ?? abs;
}

/**
 * @param {string} name A project's name.
 * @returns {string} Its tile letter: the first letter or digit, upper-cased; `?` when there is none.
 */
export function initialOf(name) {
  return name.match(/[\p{L}\p{N}]/u)?.[0].toLocaleUpperCase() ?? '?';
}

/**
 * @param {string} path Absolute.
 * @param {string | null} home The home folder, without a trailing separator.
 * @returns {string} The path with the home folder shown as `~`.
 */
export function tildePath(path, home) {
  return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * @param {string} path A project's absolute path.
 * @param {string | null} home
 * @returns {string} The folder it lies in, as `tildePath` shows it.
 */
export function parentLabel(path, home) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return tildePath(path.slice(0, Math.max(cut, 1)), home);
}

/**
 * @param {readonly { id: string, projectId: string }[]} sessions
 * @param {readonly string[]} unread Ids of the unread sessions.
 * @returns {Record<string, number>} How many unread sessions each project has; projects with none are left out.
 */
export function unreadByProject(sessions, unread) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of sessions) if (unread.includes(s.id)) counts[s.projectId] = (counts[s.projectId] ?? 0) + 1;
  return counts;
}
