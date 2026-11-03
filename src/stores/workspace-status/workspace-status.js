import { computed } from 'nanostores';
import { $now } from '../clock/clock.js';
import { $projectPath } from '../project/project.js';
import { $permissionRequests } from '../session-runtime/session-runtime.js';
import { $unreadSessions } from '../session-read/session-read.js';
import { $sessions } from '../sessions/sessions.js';
import { $activeWorkspaceId, $workspaces, $workspacesProject, MAIN } from '../workspaces/workspaces.js';
import { orderWorkspaces, statusesOf } from '../../hooks/workspaces/rules.js';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../hooks/workspaces/types.js').WorkspaceStatus} WorkspaceStatus */

/** The shown project's workspaces; none with no project. */
const $listed = computed([$projectPath, $workspaces], (path, list) => (path === null ? [] : list));

/** The status of each workspace of the shown project and of Main (`main`); empty with no project. */
export const $workspaceStatuses = computed(
  [$projectPath, $listed, $sessions, $permissionRequests, $unreadSessions, $now],
  (path, list, sessions, permissions, unread, now) => {
    if (path === null) return /** @type {Record<string, WorkspaceStatus>} */ ({});
    return statusesOf(path, list, sessions, { pending: new Set(Object.keys(permissions)), unread: new Set(unread), now });
  },
);

/** The picker's Active group, in its order (`orderWorkspaces()`). */
export const $pickerWorkspaces = computed([$listed, $workspaceStatuses, $sessions], (list, statuses, sessions) =>
  orderWorkspaces(list, statuses, sessions),
);

/** The picker's rows' ids in its order: the Active group, then Main. */
export const $pickerOrder = computed($pickerWorkspaces, (list) => [...list.map((w) => w.id), MAIN]);

/** Names of the shown project's workspaces that wait, other than the shown one, in the picker's order. */
export const $waitingElsewhere = computed(
  [$pickerWorkspaces, $workspaceStatuses, $activeWorkspaceId],
  (list, statuses, shown) => {
    const names = [...list.map((w) => [w.id, w.name]), [MAIN, 'Main']];
    return names.filter(([id]) => id !== shown && statuses[id] === 'waiting').map(([, name]) => name);
  },
);

/**
 * Each workspace's shortcut number (`workspace<n>`): Main is 1, the stored ones 2…9 by creation,
 * oldest first. Only Main while the shown project's list loads (`$workspaces` is still another's).
 */
export const $workspaceNumbers = computed([$projectPath, $workspaces, $workspacesProject], (path, list, listedFor) => {
  const numbered = listedFor === path ? list.slice(0, 8) : [];
  return Object.fromEntries([[MAIN, 1], ...numbered.map((w, i) => [w.id, i + 2])]);
});
