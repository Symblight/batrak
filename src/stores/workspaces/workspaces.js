import { atom, computed } from 'nanostores';
import { persistentMapStore } from '../persistent/persistent.js';
import { $openRoots, $project, $projectPath } from '../project/project.js';
import { MAIN, folderOfWorkspace } from '../../hooks/workspaces/folder.js';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').ActiveRoot} ActiveRoot */

export { MAIN };

/** The shown project's workspaces, oldest first, as the backend lists them (`workspaces` hook). */
export const $workspaces = atom(/** @type {readonly Workspace[]} */ ([]));

/** The project `$workspaces` was listed for; until it's the shown one, a stored choice waits for it. */
export const $workspacesProject = atom(/** @type {string | null} */ (null));

/**
 * @param {readonly Workspace[]} list
 * @param {string | null} [projectPath] The project it's of.
 */
export function setWorkspaces(list, projectPath = null) {
  $workspaces.set(list);
  $workspacesProject.set(projectPath);
}

/** The workspace shown per project path (`main` for Main). Per window, so each window keeps its own. */
const $activeWorkspaceIds = persistentMapStore('brama:workspaces:active:', (raw) => (typeof raw === 'string' ? raw : null));

/**
 * Shows a workspace of a project in this window.
 * @param {string} projectPath
 * @param {string} id `main` for Main.
 */
export function setActiveWorkspace(projectPath, id) {
  if ($activeWorkspaceIds.get()[projectPath] !== id) $activeWorkspaceIds.setKey(projectPath, id);
}

/**
 * The shown workspace's id: the one chosen for the shown project, Main when none was or it's gone. A
 * choice waits (unchanged) while the project's list loads.
 */
export const $activeWorkspaceId = computed(
  [$projectPath, $activeWorkspaceIds, $workspaces, $workspacesProject],
  (project, ids, list, listedFor) => {
    const id = project === null ? undefined : ids[project];
    if (id === undefined || id === MAIN) return MAIN;
    if (listedFor !== project) return id;
    return list.some((w) => w.id === id) ? id : MAIN;
  },
);

/** The shown workspace's record; `null` for Main or one still loading. */
export const $activeWorkspace = computed([$workspaces, $activeWorkspaceId], (list, id) => list.find((w) => w.id === id) ?? null);

/** The folder of the workspace whose root is being scanned; `null` when none is. */
export const $workspaceOpening = atom(/** @type {string | null} */ (null));

/** The folder the window shows: Main's or the active workspace's, its root once open. */
export const $activeRoot = computed(
  [$project, $activeWorkspaceId, $activeWorkspace, $openRoots, $workspaceOpening],
  (project, id, workspace, open, opening) => {
    if (project === null) return /** @type {ActiveRoot} */ ({ path: null, rootId: null, opening: false });
    const path = folderOfWorkspace(project.path, id, workspace === null ? [] : [workspace]);
    // A listed one still loading is on its way.
    if (path === null) return /** @type {ActiveRoot} */ ({ path: null, rootId: null, opening: true });
    if (id === MAIN) return /** @type {ActiveRoot} */ ({ path, rootId: project.rootId ?? null, opening: false });
    const rootId = open[path] ?? null;
    // One still checking out shows the skeleton until its root opens.
    const pending = workspace?.creating === true || opening === path;
    return /** @type {ActiveRoot} */ ({ path, rootId, opening: rootId === null && pending });
  },
);

/**
 * The shown folder (the active root's path): the key of what's kept per folder (editor tabs,
 * terminals); `null` with no project or a list still loading.
 */
export const $shownFolder = computed($activeRoot, (root) => root.path);

/** The active root's backend id; notifies only when it changes. */
export const $rootId = computed($activeRoot, (root) => root.rootId);
