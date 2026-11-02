import { atom } from 'nanostores';

/** @typedef {import('../../hooks/github/types.js').GithubAccount} GithubAccount */
/** @typedef {import('../../hooks/github/types.js').GithubSignIn} GithubSignIn */

/** @type {GithubSignIn} */
export const SIGN_IN_IDLE = { phase: 'idle', code: null, error: null, installCommand: null };

/** Who the GitHub CLI is signed in as; `null` until first read. Written by the `github` hook. */
export const $githubAccount = atom(/** @type {GithubAccount | null} */ (null));

/** The sign-in dialog. Written by the `github` hook. */
export const $githubSignIn = atom(SIGN_IN_IDLE);
