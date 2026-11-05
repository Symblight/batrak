/**
 * A workspace of the shown project, as the backend lists it (`workspace::Workspace`): a task
 * with its own folder (a git worktree) on branch `brama/<slug>`. Main, the project's own folder,
 * isn't one.
 * @typedef {Object} Workspace
 * @property {string} id
 * @property {string} projectPath
 * @property {string} name
 * @property {'user' | 'agent'} nameSource
 * @property {string} folder The project's folder in the worktree: its chats' cwd.
 * @property {string} worktreePath
 * @property {string} branch
 * @property {string} baseCommit
 * @property {string | null} baseBranch
 * @property {string} createdAt
 * @property {boolean} creating Its checkout runs.
 * @property {string | null} error Why its last checkout failed.
 * @property {boolean} missing Its folder was deleted outside Batrak.
 * @property {boolean} checkedOut Its first checkout succeeded once.
 */

/**
 * What marks a file as a workspace's.
 * @typedef {Pick<Workspace, 'projectPath' | 'folder' | 'branch'>} WorktreeFolder
 */

/**
 * What a workspace's dot says: the strongest of its chats' states (`statusOf()`).
 * @typedef {'waiting' | 'error' | 'working' | 'unread' | 'idle'} WorkspaceStatus
 */

/**
 * What deleting a workspace would touch (`workspace_delete_preview`).
 * @typedef {Object} DeletePreview
 * @property {number} uncommitted
 * @property {number} commits Past its base.
 * @property {string[]} working Titles of its chats in a turn.
 */

/**
 * The folder the window shows (the active workspace's, or the project's) and its backend root.
 * @typedef {Object} ActiveRoot
 * @property {string | null} path
 * @property {string | null} rootId `null` until its root is open.
 * @property {boolean} opening Its root is being scanned.
 */

export {};
