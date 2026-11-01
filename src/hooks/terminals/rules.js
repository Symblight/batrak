/** @typedef {import('../app/types.js').Platform} Platform */
/** @typedef {import('../sessions/types.js').Session} Session */

/**
 * @typedef {Object} TerminalFolder
 * @property {string} cwd
 * @property {string | null} fallback Where to start when `cwd` doesn't exist.
 */

/** What a POSIX shell takes literally only after a backslash (as Terminal.app types a dropped file). */
const POSIX_SPECIAL = /[ \t'"\\$`!&*()[\]{};<>?|#~]/g;
/** What makes cmd or PowerShell split or expand a path: it goes in double quotes (as Windows Terminal does). */
const WINDOWS_SPECIAL = /[ &()[\]{}^=;!'+,`~%]/;

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * @param {string} path
 * @param {Platform} platform
 */
function quote(path, platform) {
  if (platform === 'windows') return WINDOWS_SPECIAL.test(path) ? `"${path}"` : path;
  return path.replace(POSIX_SPECIAL, '\\$&');
}

/**
 * Where New Terminal starts: the active session's folder (a draft's is its project), else the
 * project, with the project as fallback; with no project, the home folder.
 * @param {{ activeFolder: string | null, project: string | null, home: string }} where
 * @returns {TerminalFolder}
 */
export function newTerminalFolder({ activeFolder, project, home }) {
  if (project === null) return { cwd: home, fallback: null };
  return { cwd: activeFolder ?? project, fallback: project };
}

/**
 * Where Project Terminal starts: always the project folder, with the project as fallback; with no
 * project, the home folder.
 * @param {{ project: string | null, home: string }} where
 * @returns {TerminalFolder}
 */
export function projectTerminalFolder({ project, home }) {
  if (project === null) return { cwd: home, fallback: null };
  return { cwd: project, fallback: project };
}

/**
 * Where a session's Open in → Terminal starts.
 * @param {Session} session
 * @returns {TerminalFolder}
 */
export function sessionTerminalFolder(session) {
  return { cwd: session.folder, fallback: session.projectId };
}

/**
 * A folder's name for a terminal's title: a worktree's folder is named after the worktree, as the
 * Files tree's root row.
 * @param {string} folder Absolute.
 * @param {readonly Session[]} sessions
 */
export function folderLabel(folder, sessions) {
  const worktree = sessions.find((s) => {
    const root = s.worktreePath;
    return root !== null && folder.startsWith(root) && ['', '/', '\\'].includes(folder.charAt(root.length));
  })?.worktreePath;
  return basename(worktree ?? folder);
}

/**
 * Files dropped on a terminal as a native terminal types them: each path escaped for the shell,
 * separated by spaces, with a trailing space; nothing for no paths.
 * @param {readonly string[]} paths Absolute.
 * @param {Platform} platform
 */
export function shellPaths(paths, platform) {
  return paths.map((path) => `${quote(path, platform)} `).join('');
}
