import { ipc } from '../ipc/ipc.js';
import { $projectPath } from '../../stores/project/project.js';
import { $activeWorkspace, $workspaceOpening, $workspaces, setWorkspaces } from '../../stores/workspaces/workspaces.js';
import { app } from '../app/app.js';
import { projects } from '../projects/projects.js';

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

/** Folders whose root this hook opened, with their project: closed once their workspace is gone. */
const opened = new Map();
/** Id of the latest root open; one that lands after a newer one is closed again. */
let openTurn = 0;

/**
 * Opens the shown workspace's folder as a backend root (`$activeRoot` follows it), or shows it at
 * once while it's still open. A workspace still checking out, or missing, opens nothing.
 * @param {Workspace | null} workspace
 */
async function follow(workspace) {
  if (workspace === null || workspace.creating || workspace.missing) {
    openTurn++;
    $workspaceOpening.set(null);
    return;
  }
  const { id, folder, projectPath } = workspace;
  const open = projects.openRoot(folder);
  if (open !== null) {
    openTurn++;
    $workspaceOpening.set(null);
    projects.showRoot(folder, open);
    return;
  }
  // The list refreshed while its root scans: that open goes on.
  if ($workspaceOpening.get() === folder) return;
  const turn = ++openTurn;
  $workspaceOpening.set(folder);
  try {
    await projects.ready();
    /** @type {import('../projects/types.js').OpenedRoot} */
    const root = await ipc.invoke('open_workspace_root', { workspaceId: id });
    if (turn !== openTurn) {
      void ipc.invoke('close_root', { rootId: root.rootId }).catch(() => {});
      return;
    }
    opened.set(folder, projectPath);
    projects.showRoot(folder, root.rootId);
  } catch (err) {
    // A newer open supersedes this one in the backend too: only the current one's failure is news.
    if (turn === openTurn) app.reportError('Opening the workspace failed', err);
  } finally {
    if (turn === openTurn) $workspaceOpening.set(null);
  }
}

/**
 * Closes the roots of the shown project's workspaces that are gone (deleted here or elsewhere).
 * @param {readonly Workspace[]} list
 */
function closeGone(list) {
  const project = $projectPath.get();
  for (const [folder, projectPath] of opened) {
    if (projectPath !== project || list.some((w) => w.folder === folder)) continue;
    opened.delete(folder);
    void projects.closeFolder(folder);
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
    const following = $activeWorkspace.subscribe((workspace) => void follow(workspace));
    const listed = $workspaces.listen(closeGone);
    const listening = ipc.listen('workspaces://changed', (/** @type {{ projectPath: string }} */ { projectPath }) => {
      if (projectPath === $projectPath.get()) void refresh(projectPath);
    });
    return () => {
      unsubscribe();
      following();
      listed();
      void listening.then((off) => off()).catch(() => {});
    };
  },
});
