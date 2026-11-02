/**
 * Who the GitHub CLI is signed in as on github.com; mirrors `github::Account`.
 * @typedef {{ state: 'noCli' } | { state: 'signedOut' } | { state: 'signedIn', login: string }} GithubAccount
 */

/**
 * What the PR slot of the header shows for the shown branch: nothing (`hidden`, or `loading` until
 * the account is known), a way in (`noCli`, `signedOut`), or the account works (`ok`).
 * @typedef {'hidden' | 'loading' | 'noCli' | 'signedOut' | 'noAccess' | 'ok'} GithubSlot
 */

/**
 * The sign-in dialog (`$githubSignIn`).
 * @typedef {Object} GithubSignIn
 * @property {'idle' | 'noCli' | 'starting' | 'code' | 'failed'} phase `idle`: closed.
 * @property {string | null} code The one-time code, once the CLI printed it.
 * @property {string | null} error Why it failed.
 * @property {string | null} installCommand `noCli`: the command that installs the CLI on this system.
 */

/**
 * A branch's pull request; mirrors `github::PullRequest`.
 * @typedef {Object} GithubPullRequest
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} state `OPEN`, `MERGED` or `CLOSED`.
 * @property {boolean} isDraft
 * @property {string | null} reviewDecision `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`.
 * @property {string | null} checks The latest commit's: `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`.
 */

/**
 * Reply of `github_pull_request`; mirrors `github::PrReply`.
 * @typedef {Object} GithubPrReply
 * @property {'ok' | 'noAccess' | 'signedOut' | 'error'} status
 * @property {GithubPullRequest | null} pr
 * @property {string | null} defaultBranch The base of a new pull request.
 * @property {string | null} message
 */

/**
 * The pull request lookup of a branch (`$pullRequest`).
 * @typedef {Object} GithubBranchPr
 * @property {string} rootId
 * @property {string} branch
 * @property {GithubPrReply} reply
 */

/**
 * How the header shows a pull request.
 * @typedef {Object} GithubPrChip
 * @property {'draft' | 'open' | 'merged' | 'closed'} state
 * @property {string} label
 * @property {string} icon Material icon name.
 * @property {'ok' | 'fail' | 'run' | null} checks The dot after the label; none for a merged or closed one.
 * @property {string} tooltip
 */

export {};
