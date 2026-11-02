import { atom, computed } from 'nanostores';
import { $gitRepo } from '../git/git.js';
import { $rootId } from '../workspace/workspace.js';

/** @typedef {import('../../hooks/github/types.js').GithubAccount} GithubAccount */
/** @typedef {import('../../hooks/github/types.js').GithubSignIn} GithubSignIn */
/** @typedef {import('../../hooks/github/types.js').GithubBranchPr} GithubBranchPr */

/** @type {GithubSignIn} */
export const SIGN_IN_IDLE = { phase: 'idle', code: null, error: null, installCommand: null };

/** Who the GitHub CLI is signed in as; `null` until first read. Written by the `github` hook. */
export const $githubAccount = atom(/** @type {GithubAccount | null} */ (null));

/** The sign-in dialog. Written by the `github` hook. */
export const $githubSignIn = atom(SIGN_IN_IDLE);

/** The last pull request lookup, of one branch of one root. Written by the `github` hook. */
export const $pullRequest = atom(/** @type {GithubBranchPr | null} */ (null));

/** [`$pullRequest`] when it is of the shown branch. */
export const $pullRequestHere = computed([$pullRequest, $rootId, $gitRepo], (found, rootId, { repo }) =>
  found && found.rootId === rootId && found.branch === repo?.branch ? found : null,
);

/**
 * What identifies the lookup to make: the shown branch of a GitHub remote, its remote commit, and a
 * signed-in account. Changes (and so asks again) when a push or fetch moves the branch; `null` when
 * there is nothing to look up.
 */
export const $pullRequestKey = computed([$rootId, $gitRepo, $githubAccount], (rootId, { repo }, account) =>
  rootId && account?.state === 'signedIn' && repo?.branch && repo.remote?.github ? `${rootId}\n${repo.branch}\n${repo.upstreamSha ?? ''}` : null,
);
