import { atom, computed } from 'nanostores';
import { isRecord, persistentStore } from './persistent.js';

/** @typedef {import('../models/types.js').Workspace} Workspace */

/**
 * The opened folder, reopened on launch by `projectController.restore()`. Per window: `rootId` is
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
 * Folder being scanned to become `$workspace`, `null` when none is. Written by `projectController`;
 * the previous workspace stays in `$workspace` meanwhile.
 */
export const $openingPath = atom(/** @type {string | null} */ (null));

/** Notifies only when the backend root changes, not on every `$workspace` write. */
export const $rootId = computed($workspace, (workspace) => workspace?.rootId ?? null);
