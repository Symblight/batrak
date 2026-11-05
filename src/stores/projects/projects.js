import { isRecord, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/projects/types.js').Project} Project */

/** Projects listed in the session column. Shared by every window, like a recent-folders list. */
export const $projects = persistentStore('brama:projects', /** @type {Project[]} */ ([]), {
  parse: (raw) => {
    if (!Array.isArray(raw)) return null;
    /** @type {Project[]} */
    const projects = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.name !== 'string') continue;
      if (projects.some((p) => p.id === item.path)) continue;
      projects.push({ id: item.path, name: item.name, path: item.path });
    }
    return projects;
  },
  serialize: (projects) => projects.map(({ name, path }) => ({ name, path })),
});

/** Ids of projects whose session list is collapsed. */
export const $collapsedProjects = persistentStore('brama:projects:collapsed', /** @type {string[]} */ ([]), {
  parse: (raw) => (Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : null),
});

/**
 * Lists a folder as a project (no-op when already listed).
 * @param {string} path Canonical absolute path; also the project id.
 * @param {string} name
 */
export function addProject(path, name) {
  const projects = $projects.get();
  if (!projects.some((p) => p.id === path)) $projects.set([...projects, { id: path, name, path }]);
}

/**
 * Removes a project from the list. Its folder on disk is untouched.
 * @param {string} id
 */
export function removeProject(id) {
  $projects.set($projects.get().filter((p) => p.id !== id));
  const collapsed = $collapsedProjects.get();
  if (collapsed.includes(id)) $collapsedProjects.set(collapsed.filter((c) => c !== id));
}

/**
 * Expands or collapses a project's session list.
 * @param {string} id
 * @param {boolean} [expanded] Omitted, flips the current state.
 */
export function toggleProject(id, expanded) {
  const collapsed = $collapsedProjects.get();
  const isExpanded = !collapsed.includes(id);
  if (expanded === isExpanded) return;
  $collapsedProjects.set(isExpanded ? [...collapsed, id] : collapsed.filter((c) => c !== id));
}
