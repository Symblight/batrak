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
 * @property {string | null} lastActiveAt
 * @property {boolean} creating Its checkout runs.
 * @property {string | null} error Why its last checkout failed.
 * @property {boolean} missing Its folder was deleted outside Brama.
 */

/**
 * Where a draft's first message creates its chat (`session_create`'s `workspace`): Main or a stored
 * workspace.
 * @typedef {{ kind: 'main' } | { kind: 'existing', id: string }} WorkspaceChoice
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

/**
 * Create workspace's Create (`acp-workspace-create`): an isolated workspace from `baseBranch`, or a
 * chat in the project folder (Main).
 * @typedef {Object} CreateRequest
 * @property {'isolated' | 'project'} mode
 * @property {string | null} baseBranch `null` in the project folder.
 * @property {string | null} name An isolated workspace's; `null`: named after its branch until its first chat names it.
 */

export {};
