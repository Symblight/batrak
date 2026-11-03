import { ipc } from '../ipc/ipc.js';
import { $projectPath } from '../../stores/project/project.js';
import { setWorkspaces } from '../../stores/workspaces/workspaces.js';
import { app } from '../app/app.js';

/** @typedef {import('./types.js').Workspace} Workspace */

/** Numbers refreshes: only the latest one's reply is kept, whatever order replies come in. */
let latest = 0;

/**
 * Loads the shown project's workspaces into `$workspaces`; a reply older than the latest refresh
 * (another project's, or overtaken) is dropped.
 * @param {string | null} projectPath
 */
async function refresh(projectPath) {
  const turn = ++latest;
  if (projectPath === null) {
    setWorkspaces([]);
    return;
  }
  try {
    /** @type {Workspace[]} */
    const list = await ipc.invoke('workspaces_list', { projectPath });
    if (turn === latest) setWorkspaces(Array.isArray(list) ? list : []);
  } catch (err) {
    app.reportError('Listing workspaces failed', err);
  }
}

/** A project's workspaces (docs/specs/workspaces.md): the shown project's list and its actions. */
export const workspaces = Object.freeze({
  /**
   * Follows the shown project: loads its workspaces now and on each `workspaces://changed` of it.
   * @returns {() => void} Stops following (tests; the app follows for its life).
   */
  start() {
    const unsubscribe = $projectPath.subscribe((path) => void refresh(path));
    const listening = ipc.listen('workspaces://changed', (/** @type {{ projectPath: string }} */ { projectPath }) => {
      if (projectPath === $projectPath.get()) void refresh(projectPath);
    });
    return () => {
      unsubscribe();
      void listening.then((off) => off()).catch(() => {});
    };
  },
});
