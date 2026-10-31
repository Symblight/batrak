/** @typedef {import('../types/types.js').Platform} Platform */

/** What a POSIX shell takes literally only after a backslash (as Terminal.app types a dropped file). */
const POSIX_SPECIAL = /[ \t'"\\$`!&*()[\]{};<>?|#~]/g;
/** What makes cmd or PowerShell split or expand a path: it goes in double quotes (as Windows Terminal does). */
const WINDOWS_SPECIAL = /[ &()[\]{}^=;!'+,`~%]/;

/**
 * @param {string} path
 * @param {Platform} platform
 */
function quote(path, platform) {
  if (platform === 'windows') return WINDOWS_SPECIAL.test(path) ? `"${path}"` : path;
  return path.replace(POSIX_SPECIAL, '\\$&');
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
