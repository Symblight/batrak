/** @typedef {import('./types.js').GitRepoState} GitRepoState */

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
