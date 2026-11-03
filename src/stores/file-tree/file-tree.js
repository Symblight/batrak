import { computed } from 'nanostores';
import { persistentMapStore } from '../persistent/persistent.js';
import { $sessionRoot } from '../session-root/session-root.js';
import { $project } from '../project/project.js';

/** @type {string[]} */
const NONE = [];

/**
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function parseFolders(raw) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw)].filter((path) => typeof path === 'string');
}

/**
 * Expanded folders of the file tree by the folder it lists (a project, or a worktree session's
 * folder), one storage item each; root-relative paths. Per window, like the tabs (`$projectTabs`):
 * only the listed folder's entry is shown (`$expandedFolders`), the others wait for it.
 */
export const $projectExpandedFolders = persistentMapStore('brama:file-tree:expanded:', parseFolders);

/**
 * Expanded folders of the listed folder, including ones whose parent isn't loaded yet. A worktree
 * with none of its own shows its project's: its folders are the project's, but a fresh checkout
 * lacks the ignored and untracked ones, which the tree would forget from the project's entry.
 */
export const $expandedFolders = computed([$projectExpandedFolders, $project, $sessionRoot], (folders, project, session) => {
  if (!project) return NONE;
  return (session && folders[session.path]) ?? folders[project.path] ?? NONE;
});

/** @param {string[]} paths Replaces the expanded folders of the listed folder. */
export function setExpandedFolders(paths) {
  const session = $sessionRoot.get();
  const root = session?.path ?? $project.get()?.path;
  if (root === undefined) return;
  // Through `setKey`: `set()` would rewrite every project's item from this window's copy. A
  // worktree keeps `[]`, which a missing entry would turn back into its project's.
  $projectExpandedFolders.setKey(root, paths.length || session ? paths : undefined);
}

/**
 * Forgets the expanded folders of a project or a worktree session's folder, e.g. when it is removed.
 * @param {string} root Its path.
 */
export function removeProjectExpandedFolders(root) {
  if (root in $projectExpandedFolders.get()) $projectExpandedFolders.setKey(root, undefined);
}
