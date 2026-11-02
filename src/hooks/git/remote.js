import { sessions } from '../sessions/sessions.js';

/** @typedef {import('./types.js').GitRepoState} GitRepoState */
/** @typedef {import('./types.js').GitRemoteChip} GitRemoteChip */

/** @param {number} n @param {string} noun */
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * What the header's remote chip shows for the branch; `null` when there is no branch to sync.
 * @param {GitRepoState | null} repo
 * @param {number} now ms.
 * @returns {GitRemoteChip | null}
 */
export function remoteChip(repo, now) {
  if (!repo?.branch) return null;
  if (!repo.hasRemotes) {
    return { id: 'none', label: 'No remote', icon: '', tooltip: 'Add a remote in a terminal: git remote add origin <url>' };
  }
  if (!repo.upstream) {
    return {
      id: 'publish',
      label: 'Publish',
      icon: 'cloud_upload',
      tooltip: `Branch ${repo.branch} is not on ${repo.remote?.name ?? 'a remote'} yet`,
    };
  }
  const fetched = repo.fetchedAt === null ? 'not fetched yet' : `fetched ${sessions.ageLabel(new Date(repo.fetchedAt).toISOString(), now)}`;
  const { ahead, behind, upstream } = repo;
  if (ahead && behind) {
    return {
      id: 'diverged',
      label: `↑${ahead} | ↓${behind}`,
      icon: 'swap_vert',
      tooltip: `Diverged from ${upstream}: ${ahead} to push, ${behind} to pull · ${fetched}`,
    };
  }
  if (ahead) {
    return { id: 'push', label: `Push ${ahead}`, icon: 'arrow_upward', tooltip: `${count(ahead, 'commit')} to push to ${upstream} · ${fetched}` };
  }
  if (behind) {
    return { id: 'pull', label: `Pull ${behind}`, icon: 'arrow_downward', tooltip: `${count(behind, 'commit')} to pull from ${upstream} · ${fetched}` };
  }
  return { id: 'synced', label: 'Synced', icon: 'check', tooltip: `Up to date with ${upstream} · ${fetched}` };
}
