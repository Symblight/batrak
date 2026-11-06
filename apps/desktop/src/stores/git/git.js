import { atom, computed } from 'nanostores';
import { persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../hooks/git/types.js').DiffLayout} DiffLayout */

/** @type {GitRepoView} */
export const NO_REPO = { repo: null, error: null };

/** @type {GitChangesView} */
export const NO_CHANGES = { files: [], loaded: false, loading: false, error: null };

/** Branch of the active root; written by the `git` hook. */
export const $gitRepo = atom(NO_REPO);

/** Changed files of the active root, while the Changes panel is open; written by the `git` hook. */
export const $gitChanges = atom(NO_CHANGES);

/** How many files `$gitChanges` lists; 0 until they load and when the scan failed. */
export const $uncommittedCount = computed($gitChanges, (changes) => (changes.loaded && !changes.error ? changes.files.length : 0));

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

/**
 * @param {unknown} raw What was stored.
 * @returns {DiffLayout | null}
 */
export function parseDiffLayout(raw) {
  return raw === 'unified' || raw === 'split' ? raw : null;
}

/** How the Changes tabs show a file's diff; shared by every window. */
export const $diffLayout = persistentStore('batrak:git:diff-layout', /** @type {DiffLayout} */ ('unified'), { parse: parseDiffLayout });

/** @param {DiffLayout} layout */
export function setDiffLayout(layout) {
  $diffLayout.set(layout);
}
