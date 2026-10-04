import { atom, computed } from 'nanostores';

/** @typedef {import('../models/types.js').GitView} GitView */

/** @type {GitView} */
export const NO_GIT = { repo: null, files: [], error: null };

/** Git state of the active root; written by `gitController`. */
export const $git = atom(NO_GIT);

/** Notifies only when HEAD moves (commit, checkout, reset), not on every status refresh. */
export const $gitHead = computed($git, ({ repo }) => (repo ? `${repo.branch ?? ''}@${repo.sha ?? ''}` : null));
