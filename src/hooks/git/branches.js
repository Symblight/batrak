import { workingIn } from './remote.js';

/** @typedef {import('./types.js').GitBranchList} GitBranchList */
/** @typedef {import('./types.js').GitBranchRow} GitBranchRow */
/** @typedef {import('./types.js').GitRemoteBranch} GitRemoteBranch */
/** @typedef {import('../sessions/types.js').Session} Session */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A worktree session's own branches start with this. */
const SESSION_PREFIX = 'brama/';

/**
 * How long ago, compactly: "now", "5m", "2h", "3d".
 * @param {number} at ms.
 * @param {number} now ms.
 */
function shortAge(at, now) {
  const age = now - at;
  if (age < MINUTE) return 'now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  return `${Math.floor(age / DAY)}d`;
}

/**
 * The branch popover's lists: the current branch first with its counts and age, the others as they come
 * (newest commit first) with their age, a session's branch marked; remote branches with no local one.
 * @param {GitBranchList} list
 * @param {string} filter A part of a name, any case.
 * @param {number} now ms.
 * @returns {{ local: GitBranchRow[], remote: GitRemoteBranch[] }}
 */
export function branchRows(list, filter, now) {
  const wanted = filter.trim().toLowerCase();
  const matches = (/** @type {string} */ name) => name.toLowerCase().includes(wanted);
  const rows = list.local
    .filter((b) => matches(b.name))
    .map((b) => {
      const counts = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
      const age = shortAge(b.committedAt, now);
      const detail = b.current ? [counts, age].filter(Boolean).join(' · ') : b.name.startsWith(SESSION_PREFIX) ? `session · ${age}` : age;
      return { name: b.name, current: b.current, detail };
    });
  return {
    local: [...rows.filter((r) => r.current), ...rows.filter((r) => !r.current)],
    remote: list.remote.filter((b) => matches(b.name)).map(({ name, remote }) => ({ name, remote })),
  };
}

/**
 * Why the branch can't be switched now: an agent works in `folder`, and a switch would change its
 * files under it. `null` when nobody does.
 * @param {readonly Session[]} sessions
 * @param {string} folder The project's folder.
 * @returns {string | null}
 */
export function switchBlocked(sessions, folder) {
  const working = workingIn(sessions, folder);
  return working && `${working.who}. Switch branches when ${working.many ? 'they are' : 'it is'} done.`;
}
