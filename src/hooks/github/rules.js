/** @typedef {import('./types.js').GithubAccount} GithubAccount */
/** @typedef {import('./types.js').GithubSlot} GithubSlot */
/** @typedef {import('../git/types.js').GitRepoState} GitRepoState */

/**
 * What the header's pull request slot shows: only a branch whose remote is on github.com has one.
 * @param {GitRepoState | null} repo
 * @param {GithubAccount | null} account `null` until first read.
 * @returns {GithubSlot}
 */
export function slot(repo, account) {
  if (!repo?.branch || !repo.remote?.github) return 'hidden';
  if (account === null) return 'loading';
  return account.state === 'signedIn' ? 'ok' : account.state;
}

/**
 * The command that installs the GitHub CLI on a system, or `null` where there is no one-liner.
 * @param {string} platform `navigator.platform`.
 */
export function installCommand(platform) {
  if (/mac/i.test(platform)) return 'brew install gh';
  if (/win/i.test(platform)) return 'winget install --id GitHub.cli';
  return null;
}
