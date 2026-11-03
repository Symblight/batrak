import { atom, computed } from 'nanostores';
import { persistentMapStore } from '../persistent/persistent.js';
import { $openRoots, $project, $projectPath } from '../project/project.js';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').DraftWorkspace} DraftWorkspace */
/** @typedef {import('../../hooks/workspaces/types.js').ActiveRoot} ActiveRoot */

/** Main's id: the project's own folder, never stored as a workspace. */
export const MAIN = 'main';

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

/**
 * Workspaces created without a name, by id: in the page only until their first message places one
 * (named after it). Dropped when left without a message.
 */
export const $draftWorkspaces = atom(/** @type {Readonly<Record<string, DraftWorkspace>>} */ ({}));

/**
 * A draft workspace in a project, based on `baseBranch`.
 * @param {string} projectPath
 * @param {string | null} baseBranch
 * @returns {string} Its id.
 */
export function addDraftWorkspace(projectPath, baseBranch) {
  const id = `draft-${crypto.randomUUID()}`;
  $draftWorkspaces.set({ ...$draftWorkspaces.get(), [id]: { id, projectPath, baseBranch } });
  return id;
}

/** @param {string} id */
export function dropDraftWorkspace(id) {
  const { [id]: dropped, ...rest } = $draftWorkspaces.get();
  if (dropped !== undefined) $draftWorkspaces.set(rest);
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
  [$projectPath, $activeWorkspaceIds, $workspaces, $workspacesProject, $draftWorkspaces],
  (project, ids, list, listedFor, drafts) => {
    const id = project === null ? undefined : ids[project];
    if (id === undefined || id === MAIN) return MAIN;
    if (drafts[id]?.projectPath === project) return id;
    if (listedFor !== project) return id;
    return list.some((w) => w.id === id) ? id : MAIN;
  },
);

/** The shown workspace's record; `null` for Main, a draft workspace or one still loading. */
export const $activeWorkspace = computed([$workspaces, $activeWorkspaceId], (list, id) => list.find((w) => w.id === id) ?? null);

/** The folder of the workspace whose root is being scanned; `null` when none is. */
export const $workspaceOpening = atom(/** @type {string | null} */ (null));

/** The folder the window shows: Main's or the active workspace's, its root once open. */
export const $activeRoot = computed(
  [$project, $activeWorkspaceId, $activeWorkspace, $openRoots, $workspaceOpening],
  (project, id, workspace, open, opening) => {
    if (id === MAIN) {
      return /** @type {ActiveRoot} */ ({ path: project?.path ?? null, rootId: project?.rootId ?? null, opening: false });
    }
    // A draft workspace has no folder yet; a listed one still loading is on its way.
    if (workspace === null) return /** @type {ActiveRoot} */ ({ path: null, rootId: null, opening: !id.startsWith('draft-') });
    const rootId = open[workspace.folder] ?? null;
    return /** @type {ActiveRoot} */ ({ path: workspace.folder, rootId, opening: rootId === null && opening === workspace.folder });
  },
);

/** The active root's backend id; notifies only when it changes. */
export const $rootId = computed($activeRoot, (root) => root.rootId);
