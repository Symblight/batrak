// No imports: `stores/workspaces/` imports this, and `rules.js` reaches the stores.

/** @typedef {import('./types.js').Workspace} Workspace */

/** Main's id: the project's own folder, never stored as a workspace. */
export const MAIN = 'main';

/**
 * A workspace's folder: Main's is the project, a listed one's its own.
 * @param {string} projectPath
 * @param {string} id `main` for Main.
 * @param {readonly Pick<Workspace, 'id' | 'folder'>[]} list The project's workspaces.
 * @returns {string | null} `null` for one not listed (yet).
 */
export function folderOfWorkspace(projectPath, id, list) {
  if (id === MAIN) return projectPath;
  return list.find((w) => w.id === id)?.folder ?? null;
}
