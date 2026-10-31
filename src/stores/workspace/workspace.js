import { atom, computed } from 'nanostores';
import { isRecord, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../models/types/types.js').Workspace} Workspace */
/** @typedef {import('../../models/types/types.js').WorkspaceSettings} WorkspaceSettings */

/**
 * The opened folder, reopened on launch by `projects.restore()`. Per window: `rootId` is
 * never stored, and another window's folder must not replace this one's.
 */
export const $workspace = persistentStore('brama:workspace', /** @type {Workspace | null} */ (null), {
  parse: (raw) =>
    isRecord(raw) && typeof raw.path === 'string' && typeof raw.name === 'string'
      ? { path: raw.path, name: raw.name, rootId: null }
      : null,
  serialize: (workspace) => workspace && { path: workspace.path, name: workspace.name },
  listen: false,
});

/**
 * Folder being scanned to become `$workspace`, `null` when none is. Written by `projects`;
 * the previous workspace stays in `$workspace` meanwhile.
 */
export const $openingPath = atom(/** @type {string | null} */ (null));

/** Notifies only when the backend root changes, not on every `$workspace` write. */
export const $rootId = computed($workspace, (workspace) => workspace?.rootId ?? null);

/** Notifies only when the opened folder changes. */
export const $workspacePath = computed($workspace, (workspace) => workspace?.path ?? null);

/** @type {WorkspaceSettings} */
const DEFAULT_SETTINGS = { defaultMode: 'local', localTurns: 'queue' };

/** The opened folder's `.brama/workspace.json`, read when it opens; the defaults until then. */
export const $workspaceSettings = atom(DEFAULT_SETTINGS);

/** @param {WorkspaceSettings | null} settings `null`: the defaults. */
export function setWorkspaceSettings(settings) {
  $workspaceSettings.set(settings ?? DEFAULT_SETTINGS);
}
