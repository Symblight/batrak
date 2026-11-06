/** @typedef {import('./types.js').GitRepoState} GitRepoState */

/** @type {Record<import('./types.js').GitOperation, string>} */
const OPERATIONS = { merge: 'Merge', rebase: 'Rebase', cherryPick: 'Cherry-pick', revert: 'Revert', bisect: 'Bisect' };

/**
 * What stopped midway in the repository, for the Changes pane; `null` when nothing did.
 * @param {GitRepoState | null} repo
 */
export function operationLine(repo) {
  return repo?.operation ? `${OPERATIONS[repo.operation]} in progress` : null;
}

/** @param {number} n @param {string} word */
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How the branch stands against its remote, as of the last fetch: the branch card's Remote row.
 * @param {GitRepoState} repo
 */
export function remoteLine(repo) {
  const remote = repo.remote?.name;
  if (!remote) return 'No remote';
  if (!repo.upstream) return `Not on ${remote} yet`;
  const { ahead, behind } = repo;
  if (ahead && behind) return `${ahead} to push, ${behind} to pull: diverged from ${remote}`;
  if (ahead) return `${count(ahead, 'commit')} to push to ${remote}`;
  if (behind) return `${count(behind, 'commit')} to pull from ${remote}`;
  return `In sync with ${remote}`;
}

/**
 * The branches the current one can be compared to: all but itself, also as git lists one a tag of
 * the same name shadows (`heads/main`).
 * @param {import('./types.js').BranchList} list
 * @param {GitRepoState | null} repo
 * @returns {import('./types.js').BranchList}
 */
export function compareBranches(list, repo) {
  const current = repo?.branch;
  if (!current) return list;
  return { ...list, local: list.local.filter((name) => name !== current && name !== `heads/${current}`) };
}
