import { ipc } from '../ipc/ipc.js';
import { $projectPath } from '../../stores/project/project.js';
import {
  $activeWorkspace,
  $activeWorkspaceId,
  $draftWorkspaces,
  $workspaceOpening,
  $workspaces,
  MAIN,
  addDraftWorkspace,
  dropDraftWorkspace,
  setActiveWorkspace,
  setWorkspaces,
} from '../../stores/workspaces/workspaces.js';
import { $activeSession, $sessions, dropDrafts } from '../../stores/sessions/sessions.js';
import { selectAgent } from '../../stores/composer/composer.js';
import { openSessionChanges } from '../../stores/editor/editor.js';
import { notify } from '../../stores/notices/notices.js';
import { app } from '../app/app.js';
import { projects } from '../projects/projects.js';

/** @typedef {import('./types.js').Workspace} Workspace */
/** @typedef {import('./types.js').DeletePreview} DeletePreview */

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
    if (turn === latest) setWorkspaces(Array.isArray(list) ? list : [], projectPath);
  } catch (err) {
    app.reportError('Listing workspaces failed', err);
    // Listed as none: a stored choice falls back to Main instead of waiting for a list that won't come.
    if (turn === latest) setWorkspaces([], projectPath);
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

/**
 * The shown chat's workspace is the shown one: a chat of another workspace of the shown project
 * (from a banner, a notice, or a draft workspace's first chat now placed) switches to it once its
 * workspace is listed.
 */
function followChat() {
  const session = $activeSession.get();
  const project = $projectPath.get();
  if (session === null || project === null || session.projectId !== project) return;
  const id = session.workspaceId ?? MAIN;
  if (id === $activeWorkspaceId.get()) return;
  if (id !== MAIN && !(id in $draftWorkspaces.get()) && !$workspaces.get().some((w) => w.id === id)) return;
  setActiveWorkspace(project, id);
}

/**
 * Draft workspaces not shown go with their unsent drafts, unless a chat of theirs is being created
 * (a refused create comes back to its draft); once that chat's workspace is placed, it goes too.
 */
function sweepDrafts() {
  const shown = $activeWorkspaceId.get();
  const chats = $sessions.get();
  for (const id of Object.keys($draftWorkspaces.get())) {
    if (id === shown || chats.some((s) => s.workspaceId === id)) continue;
    dropDraftWorkspace(id);
    dropDrafts(id);
  }
}

/** @param {string} id */
const recordOf = (id) => $workspaces.get().find((w) => w.id === id) ?? null;

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
    const chats = [
      $activeSession.listen(followChat),
      $workspaces.listen(followChat),
      $activeWorkspaceId.listen(sweepDrafts),
      $sessions.listen(sweepDrafts),
    ];
    return () => {
      unsubscribe();
      following();
      listed();
      for (const off of chats) off();
      void listening.then((off) => off()).catch(() => {});
    };
  },

  /**
   * Shows a workspace of the shown project.
   * @param {string} id `main` for Main.
   */
  select(id) {
    const project = $projectPath.get();
    if (project !== null) setActiveWorkspace(project, id);
  },

  /**
   * New workspace: with a name, placed and checked out now; without, a draft until its first
   * message. Either way it's shown with a new chat of `agentId`.
   * @param {{ name: string | null, baseBranch: string | null, agentId: string | null }} request
   */
  async create({ name, baseBranch, agentId }) {
    const project = $projectPath.get();
    if (project === null) return;
    let id;
    if (name === null) id = addDraftWorkspace(project, baseBranch);
    else {
      try {
        /** @type {Workspace} */
        const created = await ipc.invoke('workspace_create', { projectPath: project, name, baseBranch });
        if ($projectPath.get() !== project) return;
        if (!$workspaces.get().some((w) => w.id === created.id)) setWorkspaces([...$workspaces.get(), created], project);
        id = created.id;
      } catch (err) {
        app.reportError('Creating the workspace failed', err);
        return;
      }
    }
    setActiveWorkspace(project, id);
    if (agentId !== null) selectAgent(agentId);
  },

  /**
   * @param {string} id
   * @param {string} name
   */
  async rename(id, name) {
    try {
      await ipc.invoke('workspace_rename', { id, name });
    } catch (err) {
      app.reportError('Renaming the workspace failed', err);
    }
  },

  /**
   * Delete workspace…: asks in `dialog` with what deleting would touch; the dialog's Delete fires
   * `acp-workspace-delete`.
   * @param {string} id
   * @param {HTMLElementTagNameMap['acp-workspace-delete-dialog'] | null} dialog
   */
  async confirmDelete(id, dialog) {
    const record = recordOf(id);
    if (record === null || dialog === null) return;
    try {
      /** @type {DeletePreview} */
      const preview = await ipc.invoke('workspace_delete_preview', { id });
      await dialog.show(record, preview);
    } catch (err) {
      app.reportError('Checking the workspace failed', err);
    }
  },

  /**
   * Deletes a workspace with its chats (its uncommitted work saved as a commit on its branch); the
   * window shows Main first, and nothing watches its folder while it goes.
   * @param {string} id
   * @param {boolean} keepBranch
   */
  async delete(id, keepBranch) {
    const project = $projectPath.get();
    const record = recordOf(id);
    if (project !== null && $activeWorkspaceId.get() === id) setActiveWorkspace(project, MAIN);
    if (record !== null) {
      opened.delete(record.folder);
      await projects.closeFolder(record.folder);
    }
    try {
      await ipc.invoke('workspace_delete', { id, keepBranch });
    } catch (err) {
      app.reportError('Deleting the workspace failed', err);
      return;
    }
    dropDrafts(id);
  },

  /**
   * Checks a workspace's folder out again (a missing folder, a failed checkout).
   * @param {string} id
   */
  async recreate(id) {
    try {
      await ipc.invoke('workspace_recreate', { id });
    } catch (err) {
      app.reportError('Recreating the folder failed', err);
    }
  },

  /**
   * Apply to Main: the workspace's work since its base, unstaged in the project's checkout.
   * @param {string} id
   */
  async apply(id) {
    const name = recordOf(id)?.name ?? 'the workspace';
    try {
      /** @type {import('../sessions/types.js').ApplyResult} */
      const result = await ipc.invoke('workspace_apply_locally', { id });
      if (result.outcome === 'conflicts') notify('warn', `Applied "${name}" with conflicts in ${result.conflicts.join(', ')}`);
      else if (result.outcome === 'empty') notify('info', `"${name}" has no changes to apply`);
      else notify('info', `Applied "${name}" to Main, unstaged`);
    } catch (err) {
      app.reportError('Applying the workspace failed', err);
    }
  },

  /**
   * Check out branch in Main: stops the workspace's chats and checks its branch out in the project.
   * @param {string} id
   */
  async checkOut(id) {
    const branch = recordOf(id)?.branch ?? 'the branch';
    try {
      await ipc.invoke('workspace_check_out_branch', { id });
      notify('info', `Checked out ${branch} in Main`);
    } catch (err) {
      app.reportError(`Checking out ${branch} failed`, err);
    }
  },

  /**
   * Changes since base: the review tab of the workspace's oldest chat (its worktree is the
   * workspace's), until the review is keyed by workspace.
   * @param {string} id
   */
  changes(id) {
    const chat = $sessions
      .get()
      .filter((s) => s.workspaceId === id)
      .reduce((/** @type {import('../sessions/types.js').Session | null} */ a, s) => (a === null || s.createdAt < a.createdAt ? s : a), null);
    if (chat === null) notify('info', 'Send a first message in this workspace to review its changes');
    else openSessionChanges(chat.id);
  },
});
