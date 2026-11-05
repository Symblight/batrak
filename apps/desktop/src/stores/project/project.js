import { atom, computed } from 'nanostores';
import { isRecord, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/projects/types.js').OpenProject} OpenProject */

/** Moves the folder stored under the key used before workspaces were projects' tasks. */
function migrateLegacyKey() {
  const legacy = localStorage.getItem('batrak:workspace');
  if (legacy === null) return;
  if (localStorage.getItem('batrak:project') === null) localStorage.setItem('batrak:project', legacy);
  localStorage.removeItem('batrak:workspace');
}

try {
  migrateLegacyKey();
} catch {
  // Storage unavailable (private mode): there is nothing saved to move.
}

/**
 * The opened folder, reopened on launch by `projects.restore()`. Per window: `rootId` is
 * never stored, and another window's folder must not replace this one's.
 */
export const $project = persistentStore('batrak:project', /** @type {OpenProject | null} */ (null), {
  parse: (raw) =>
    isRecord(raw) && typeof raw.path === 'string' && typeof raw.name === 'string'
      ? { path: raw.path, name: raw.name, rootId: null }
      : null,
  serialize: (project) => project && { path: project.path, name: project.name },
  listen: false,
});

/**
 * Folder being scanned to become `$project`, `null` when none is. Written by `projects`;
 * the previous project stays in `$project` meanwhile.
 */
export const $openingPath = atom(/** @type {string | null} */ (null));

/**
 * Every backend root this window keeps open, projects' and workspaces' folders alike: folder path →
 * root id. Written by the `projects` hook's roots part.
 */
export const $openRoots = atom(/** @type {Readonly<Record<string, string>>} */ ({}));

/** Notifies only when the opened folder changes. */
export const $projectPath = computed($project, (project) => project?.path ?? null);


