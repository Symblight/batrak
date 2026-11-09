import { computed } from 'nanostores';
import { $gitChanges } from '../git/git.js';
import { persistentMapStore } from '../persistent/persistent.js';
import { $project } from '../project/project.js';
import { $activeRoot } from '../workspaces/workspaces.js';

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
 * Expanded folders of the file tree by the folder it lists (a project, or a workspace's
 * folder), one storage item each; root-relative paths. Per window, like the tabs (`$folderTabs`):
 * only the listed folder's entry is shown (`$expandedFolders`), the others wait for it.
 */
export const $folderExpandedFolders = persistentMapStore('batrak:file-tree:expanded:', parseFolders);

/**
 * Expanded folders of the listed folder, including ones whose parent isn't loaded yet. A workspace
 * with none of its own shows its project's: its folders are the project's, but a fresh checkout
 * lacks the ignored and untracked ones, which the tree would forget from the project's entry.
 */
export const $expandedFolders = computed([$folderExpandedFolders, $project, $activeRoot], (folders, project, root) => {
  if (!project) return NONE;
  return (root.path !== project.path && root.path !== null && folders[root.path]) || folders[project.path] || NONE;
});

/** @param {string[]} paths Replaces the expanded folders of the listed folder. */
export function setExpandedFolders(paths) {
  const project = $project.get()?.path;
  const root = $activeRoot.get().path;
  if (project === undefined || root === null) return;
  const workspace = root !== project;
  // Through `setKey`: `set()` would rewrite every project's item from this window's copy. A
  // workspace keeps `[]`, which a missing entry would turn back into its project's.
  $folderExpandedFolders.setKey(root, paths.length || workspace ? paths : undefined);
}

/**
 * Forgets the expanded folders of a project or a workspace's folder, e.g. when it is removed.
 * @param {string} root Its path.
 */
export function removeFolderExpandedFolders(root) {
  if (root in $folderExpandedFolders.get()) $folderExpandedFolders.setKey(root, undefined);
}

/** @typedef {import('../../hooks/git/types.js').GitFileKind} GitFileKind */
/** @typedef {import('../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/**
 * How a row is marked: a file by its own status, a folder by the most serious status under it.
 * @typedef {{ kind: GitFileKind, folder: boolean }} FileMark
 */

/** @type {Record<GitFileKind, number>} */
const RANK = { added: 0, untracked: 0, modified: 1, typeChanged: 1, renamed: 1, deleted: 2, conflicted: 3 };

/** @type {ReadonlyMap<string, FileMark>} */
const NO_MARKS = new Map();

/**
 * Marks by root-relative path, for files and every folder above a changed file. A deleted file
 * marks only its folders: it has no row of its own.
 * @param {readonly GitFileStatus[]} files
 * @returns {ReadonlyMap<string, FileMark>}
 */
export function fileMarks(files) {
  /** @type {Map<string, FileMark>} */
  const marks = new Map();
  for (const { path, kind } of files) {
    if (kind !== 'deleted') marks.set(path, { kind, folder: false });
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
      const folder = path.slice(0, end);
      const mark = marks.get(folder);
      if (!mark || RANK[kind] > RANK[mark.kind]) marks.set(folder, { kind, folder: true });
    }
  }
  return marks;
}

/** @type {{ files: readonly GitFileStatus[], marks: ReadonlyMap<string, FileMark> } | null} */
let lastMarks = null;

/** Marks of the shown root's changes; empty until its status loads, outside a repo, or on error. */
export const $fileMarks = computed($gitChanges, ({ files, loaded, error }) => {
  if (!loaded || error) return NO_MARKS;
  // `files` is a new array only when the status changed: the tree doesn't redraw for nothing.
  if (lastMarks?.files !== files) lastMarks = { files, marks: fileMarks(files) };
  return lastMarks.marks;
});
