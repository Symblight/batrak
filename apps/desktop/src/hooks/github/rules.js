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
 * The branch card's Checks row: which checks of the pull request's latest commit failed, or that
 * they run or passed; `null` without checks.
 * @param {GithubPullRequest} pr
 * @returns {{ text: string, state: 'ok' | 'fail' | 'run' } | null}
 */
export function checksLine(pr) {
  const state = /** @type {'ok' | 'fail' | 'run' | undefined} */ (CHECKS[pr.checks ?? '']);
  if (!state) return null;
  if (state === 'run') return { text: 'Checks running', state };
  if (state === 'ok') return { text: 'Checks passed', state };
  const failed = pr.failedChecks;
  if (!failed.length) return { text: 'Checks failing', state };
  return { text: `${failed.length} check${failed.length === 1 ? '' : 's'} failing: ${failed.join(', ')}`, state };
}

/**
 * Where "Create PR" goes: GitHub's compare page of the branch, as it is named on the remote, against
 * the default one. Not for a branch that isn't on the remote yet, or that is the default itself.
 * @param {GitRepoState} repo
 * @param {string | null} defaultBranch
 * @returns {{ url: string | null, tooltip: string }}
 */
export function createPr(repo, defaultBranch) {
  const remote = repo.remote;
  const github = remote?.github;
  if (!remote || !github || !repo.branch) return { url: null, tooltip: '' };
  if (!repo.upstream) return { url: null, tooltip: 'Publish the branch first' };
  // `origin/team/fix` → `team/fix`: the head of the pull request is the remote branch.
  const head = repo.upstream.startsWith(`${remote.name}/`) ? repo.upstream.slice(remote.name.length + 1) : repo.branch;
  if (head === defaultBranch) return { url: null, tooltip: 'This is the default branch' };
  const path = (/** @type {string} */ name) => name.split('/').map(encodeURIComponent).join('/');
  const compared = `${encodeURIComponent(github.owner)}:${path(head)}`;
  const range = defaultBranch ? `${path(defaultBranch)}...${compared}` : compared;
  return { url: `https://github.com/${github.owner}/${github.repo}/compare/${range}?expand=1`, tooltip: `Create a pull request for ${head}` };
}

