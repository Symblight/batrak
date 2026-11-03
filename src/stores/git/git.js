import { atom, computed } from 'nanostores';
import { $rootId } from '../workspace/workspace.js';

/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../hooks/git/types.js').GitRemoteOp} GitRemoteOp */
/** @typedef {import('../../hooks/git/types.js').GitFetchError} GitFetchError */

/** @type {GitRepoView} */
export const NO_REPO = { repo: null, error: null };

/** @type {GitChangesView} */
export const NO_CHANGES = { files: [], loaded: false, loading: false, error: null };

/** Branch of the active root; written by the `git` hook. */
export const $gitRepo = atom(NO_REPO);

/** Changed files of the active root, while the Changes panel is open; written by the `git` hook. */
export const $gitChanges = atom(NO_CHANGES);

/**
 * Changed files picked for the next commit, by root-relative path; shared by the Changes panel and tab.
 * Starts empty, and is emptied when another project opens.
 */
export const $commitSelection = atom(/** @type {ReadonlySet<string>} */ (new Set()));

/** @param {Iterable<string>} ids Replaces the files picked for the next commit; no-op when unchanged. */
export function setCommitSelection(ids) {
  const next = new Set(ids);
  const current = $commitSelection.get();
  if (next.size === current.size && [...next].every((id) => current.has(id))) return;
  $commitSelection.set(next);
}

/**
 * Picks or unpicks some changed files, leaving the others as they are.
 * @param {Iterable<string>} ids
 * @param {boolean} picked
 */
export function pickForCommit(ids, picked) {
  const next = new Set($commitSelection.get());
  for (const id of ids) {
    if (picked) next.add(id);
    else next.delete(id);
  }
  setCommitSelection(next);
}

/** Notifies only when HEAD moves (commit, checkout, reset). */
export const $gitHead = computed($gitRepo, ({ repo }) => (repo ? `${repo.branch ?? ''}@${repo.sha ?? ''}` : null));

/** The fetch, pull or push running (or just failed) of each root, by root id; written by the `git` hook. */
export const $gitRemoteOps = atom(/** @type {Readonly<Record<string, GitRemoteOp>>} */ ({}));

/** The shown root's entry of [`$gitRemoteOps`]. */
export const $gitRemoteOpHere = computed([$gitRemoteOps, $rootId], (ops, rootId) => (rootId === null ? null : (ops[rootId] ?? null)));

/** Why the last background fetch failed, until one succeeds; written by the `git` hook. */
export const $gitFetchError = atom(/** @type {GitFetchError | null} */ (null));

/** [`$gitFetchError`] when it is the shown root's. */
export const $gitFetchErrorHere = computed([$gitFetchError, $rootId], (error, rootId) => (error && error.rootId === rootId ? error : null));
