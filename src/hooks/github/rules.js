/** @typedef {import('./types.js').GithubAccount} GithubAccount */
/** @typedef {import('./types.js').GithubSlot} GithubSlot */
/** @typedef {import('./types.js').GithubPrReply} GithubPrReply */
/** @typedef {import('./types.js').GithubPullRequest} GithubPullRequest */
/** @typedef {import('./types.js').GithubPrChip} GithubPrChip */
/** @typedef {import('../git/types.js').GitRepoState} GitRepoState */

/**
 * What the header's pull request slot shows: only a branch whose remote is on github.com has one.
 * @param {GitRepoState | null} repo
 * @param {GithubAccount | null} account `null` until first read.
 * @param {GithubPrReply | null} [reply] The pull request lookup of this branch, which can find the account unable to use it.
 * @returns {GithubSlot}
 */
export function slot(repo, account, reply = null) {
  if (!repo?.branch || !repo.remote?.github) return 'hidden';
  if (account === null) return 'loading';
  if (account.state !== 'signedIn') return account.state;
  return reply?.status === 'noAccess' || reply?.status === 'signedOut' ? reply.status : 'ok';
}

/** @type {Record<string, string>} */
const CHECKS = { SUCCESS: 'ok', FAILURE: 'fail', ERROR: 'fail', PENDING: 'run', EXPECTED: 'run' };
/** @type {Record<string, string>} */
const CHECK_WORDS = { ok: 'checks passed', fail: '1 check failed', run: 'checks running' };
/** @type {Record<string, string>} */
const REVIEW_WORDS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' };

/**
 * How the header shows a pull request: a state, its number, and while it is open its checks and
 * reviews in words.
 * @param {GithubPullRequest} pr
 * @returns {GithubPrChip}
 */
export function prChip(pr) {
  const number = `#${pr.number}`;
  if (pr.state === 'MERGED') return { state: 'merged', label: `${number} Merged`, icon: 'merge', checks: null, tooltip: 'Merged' };
  if (pr.state === 'CLOSED') {
    return { state: 'closed', label: `${number} Closed`, icon: 'close', checks: null, tooltip: 'Closed without merging' };
  }
  const checks = /** @type {GithubPrChip['checks']} */ (CHECKS[pr.checks ?? ''] ?? null);
  const state = pr.isDraft ? 'draft' : 'open';
  const word = pr.isDraft ? 'Draft' : 'Open';
  const tooltip = [word, checks && CHECK_WORDS[checks], REVIEW_WORDS[pr.reviewDecision ?? '']].filter(Boolean).join(' · ');
  return { state, label: `${number} ${word}`, icon: pr.isDraft ? 'edit_note' : 'merge_type', checks, tooltip };
}

/**
 * Where "Create PR" goes: GitHub's compare page of the branch against the default one. Not for a
 * branch that isn't on the remote yet, or is the default itself.
 * @param {GitRepoState} repo
 * @param {string | null} defaultBranch
 * @returns {{ url: string | null, tooltip: string }}
 */
export function createPr(repo, defaultBranch) {
  const github = repo.remote?.github;
  const branch = repo.branch;
  if (!github || !branch) return { url: null, tooltip: '' };
  if (!repo.upstream) return { url: null, tooltip: 'Publish the branch first' };
  if (branch === defaultBranch) return { url: null, tooltip: 'This is the default branch' };
  const path = (/** @type {string} */ name) => name.split('/').map(encodeURIComponent).join('/');
  const range = defaultBranch ? `${path(defaultBranch)}...${path(branch)}` : path(branch);
  return { url: `https://github.com/${github.owner}/${github.repo}/compare/${range}?expand=1`, tooltip: `Create a pull request for ${branch}` };
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
