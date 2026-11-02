/**
 * Who the GitHub CLI is signed in as on github.com; mirrors `github::Account`.
 * @typedef {{ state: 'noCli' } | { state: 'signedOut' } | { state: 'signedIn', login: string }} GithubAccount
 */

/**
 * What the PR slot of the header shows for the shown branch: nothing (`hidden`, or `loading` until
 * the account is known), a way in (`noCli`, `signedOut`), or the account works (`ok`).
 * @typedef {'hidden' | 'loading' | 'noCli' | 'signedOut' | 'ok'} GithubSlot
 */

/**
 * The sign-in dialog (`$githubSignIn`).
 * @typedef {Object} GithubSignIn
 * @property {'idle' | 'noCli' | 'starting' | 'code' | 'failed'} phase `idle`: closed.
 * @property {string | null} code The one-time code, once the CLI printed it.
 * @property {string | null} error Why it failed.
 * @property {string | null} installCommand `noCli`: the command that installs the CLI on this system.
 */

export {};
