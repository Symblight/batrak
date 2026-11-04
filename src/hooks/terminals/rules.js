/** @typedef {import('../app/types.js').Platform} Platform */
/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('../tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../workspaces/types.js').Workspace} Workspace */

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
 * Where New Terminal and the rail's first terminal start: the shown folder (Main's or the
 * workspace's), else the project (while the workspace's list loads), with the project as
 * fallback; with no project, the home folder.
 * @param {{ folder: string | null, project: string | null, home: string }} where
 * @returns {TerminalFolder}
 */
export function newTerminalFolder({ folder, project, home }) {
  if (project === null) return { cwd: home, fallback: null };
  return { cwd: folder ?? project, fallback: project };
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
 * A folder's name for a terminal's title: a workspace's folder is named after its worktree, as the
 * Files tree's root row.
 * @param {string} folder Absolute.
 * @param {readonly Pick<Workspace, 'worktreePath'>[]} workspaces
 */
export function folderLabel(folder, workspaces) {
  const worktree = workspaces.find(({ worktreePath: root }) => folder.startsWith(root) && ['', '/', '\\'].includes(folder.charAt(root.length)))?.worktreePath;
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

/**
 * @param {string} id A terminal's tab id.
 * @returns {EditorTab} The tab as a tab view takes it: a view, with no file behind it.
 */
export function terminalTab(id) {
  return {
    id,
    kind: 'terminal',
    path: '',
    content: '',
    error: '',
    loaded: false,
    image: null,
    baseline: null,
    draft: null,
    changedOnDisk: false,
    deletedOnDisk: false,
  };
}
