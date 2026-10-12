import { computed } from 'nanostores';
import { persistentMapStore } from './persistent.js';
import { $workspace } from './workspace.js';

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
 * Expanded folders of the file tree by project path, one storage item per project; root-relative
 * paths. Per window, like the tabs (`$projectTabs`): only the active project's entry is shown
 * (`$expandedFolders`), the others wait for their project to be activated.
 */
export const $projectExpandedFolders = persistentMapStore('brama:file-tree:expanded:', parseFolders);

/** Expanded folders of the active project, including ones whose parent isn't loaded yet. */
export const $expandedFolders = computed([$projectExpandedFolders, $workspace], (projects, workspace) =>
  workspace ? (projects[workspace.path] ?? NONE) : NONE,
);

/** @param {string[]} paths Replaces the expanded folders of the active project. */
export function setExpandedFolders(paths) {
  const root = $workspace.get()?.path;
  if (root === undefined) return;
  // Through `setKey`: `set()` would rewrite every project's item from this window's copy.
  $projectExpandedFolders.setKey(root, paths.length ? paths : undefined);
}

/**
 * Forgets the expanded folders of a project, e.g. when it is removed from the app.
 * @param {string} root Project path.
 */
export function removeProjectExpandedFolders(root) {
  if (root in $projectExpandedFolders.get()) $projectExpandedFolders.setKey(root, undefined);
}
