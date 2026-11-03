import { atom, computed } from 'nanostores';
import { $openRoots, $project } from '../project/project.js';
import { $activeSession } from '../sessions/sessions.js';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').ActiveRoot} ActiveRoot */

/** The shown project's workspaces, oldest first, as the backend lists them (`workspaces` hook). */
export const $workspaces = atom(/** @type {readonly Workspace[]} */ ([]));

/** @param {readonly Workspace[]} list */
export function setWorkspaces(list) {
  $workspaces.set(list);
}

/** The folder of the workspace whose root is being scanned; `null` when none is. */
export const $workspaceOpening = atom(/** @type {string | null} */ (null));

/** The shown workspace, `null` for Main. Until the picker exists, the shown chat's. */
export const $activeWorkspace = computed(
  [$workspaces, $activeSession],
  (list, session) => list.find((w) => w.id === session?.workspaceId) ?? null,
);

/** The folder the window shows: the active workspace's, else the project's; its root once open. */
export const $activeRoot = computed(
  [$project, $activeWorkspace, $openRoots, $workspaceOpening],
  (project, workspace, open, opening) => {
    if (workspace === null) {
      return /** @type {ActiveRoot} */ ({ path: project?.path ?? null, rootId: project?.rootId ?? null, opening: false });
    }
    const rootId = open[workspace.folder] ?? null;
    return /** @type {ActiveRoot} */ ({ path: workspace.folder, rootId, opening: rootId === null && opening === workspace.folder });
  },
);

/** The active root's backend id; notifies only when it changes. */
export const $rootId = computed($activeRoot, (root) => root.rootId);
