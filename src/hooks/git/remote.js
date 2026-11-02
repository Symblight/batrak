import { sessions } from '../sessions/sessions.js';

/** @typedef {import('./types.js').GitRepoState} GitRepoState */
/** @typedef {import('./types.js').GitRemoteChip} GitRemoteChip */
/** @typedef {import('./types.js').GitRemoteOp} GitRemoteOp */
/** @typedef {import('./types.js').GitRemoteAction} GitRemoteAction */
/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('../app/types.js').ConfirmOptions} ConfirmOptions */

/** @type {Record<GitRemoteAction, { running: string, failed: string, doing: string }>} */
const VERBS = {
  fetch: { running: 'Fetching…', failed: 'Fetch failed', doing: 'Fetching from' },
  pull: { running: 'Pulling…', failed: 'Pull failed', doing: 'Pulling from' },
  pullRebase: { running: 'Pulling…', failed: 'Pull failed', doing: 'Pulling from' },
  pullMerge: { running: 'Pulling…', failed: 'Pull failed', doing: 'Pulling from' },
  push: { running: 'Pushing…', failed: 'Push failed', doing: 'Pushing to' },
  publish: { running: 'Publishing…', failed: 'Publish failed', doing: 'Publishing to' },
  forcePush: { running: 'Pushing…', failed: 'Force push failed', doing: 'Force pushing to' },
  abort: { running: 'Aborting…', failed: 'Abort failed', doing: 'Aborting the pull from' },
};

/** @param {GitRemoteAction} action The name of what failed, for a snackbar ("Push failed"). */
export function remoteFailure(action) {
  return VERBS[action].failed;
}

/** Sessions in this state have a turn running, or one waiting for an answer, in their folder. */
const WORKING = new Set(['working', 'queued', 'waiting']);

/**
 * The question to ask before a pull changes the files under agents that are working in `folder`;
 * `null` when none is (a worktree session works elsewhere).
 * @param {readonly Session[]} sessions
 * @param {string} folder The project's folder.
 * @returns {ConfirmOptions | null}
 */
export function pullConfirm(sessions, folder) {
  const busy = sessions.filter((s) => s.folder === folder && WORKING.has(s.status));
  if (busy.length === 0) return null;
  const who = busy.length === 1 ? `“${busy[0].title}” is working in this folder` : `${busy.length} sessions are working in this folder`;
  return { headline: 'An agent is working here', message: `${who}. A pull changes its files under it.`, confirmLabel: 'Pull anyway' };
}

/** @param {number} n @param {string} noun */
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * What the header's remote chip shows for the branch; `null` when there is no branch to sync.
 * @param {GitRepoState | null} repo
 * @param {number} now ms.
 * @param {GitRemoteOp | null} [op] The operation running or failed for this root; it hides the branch's state.
 * @returns {GitRemoteChip | null}
 */
export function remoteChip(repo, now, op = null) {
  if (!repo?.branch) return null;
  if (op) {
    const verbs = VERBS[op.action];
    if (op.state === 'running') {
      return { id: 'busy', label: verbs.running, icon: '', tooltip: `${verbs.doing} ${repo.remote?.name ?? 'the remote'}`, action: null };
    }
    const message = op.error?.message.split('\n')[0] ?? '';
    return { id: 'failed', label: verbs.failed, icon: 'error', tooltip: message, action: null };
  }
  if (!repo.hasRemotes) {
    return { id: 'none', label: 'No remote', icon: '', tooltip: 'Add a remote in a terminal: git remote add origin <url>', action: null };
  }
  if (!repo.upstream) {
    return {
      id: 'publish',
      label: 'Publish',
      icon: 'cloud_upload',
      tooltip: `Branch ${repo.branch} is not on ${repo.remote?.name ?? 'a remote'} yet`,
      action: 'publish',
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
      action: null,
    };
  }
  if (ahead) {
    return { id: 'push', label: `Push ${ahead}`, icon: 'arrow_upward', tooltip: `${count(ahead, 'commit')} to push to ${upstream} · ${fetched}`, action: 'push' };
  }
  if (behind) {
    return { id: 'pull', label: `Pull ${behind}`, icon: 'arrow_downward', tooltip: `${count(behind, 'commit')} to pull from ${upstream} · ${fetched}`, action: 'pull' };
  }
  return { id: 'synced', label: 'Synced', icon: 'check', tooltip: `Up to date with ${upstream} · ${fetched}`, action: 'fetch' };
}
