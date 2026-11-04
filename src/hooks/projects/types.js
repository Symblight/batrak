/**
 * Project listed in the session column (`$projects`); only `name` and `path` are persisted.
 * @typedef {Object} Project
 * @property {string} id Same as `path`; sessions refer to it by `projectId`.
 * @property {string} name Last path segment.
 * @property {string} path Canonical absolute path.
 */

/**
 * Root snapshot entry; mirrors `roots::snapshot::Entry`.
 * @typedef {Object} RootEntry
 * @property {string} name
 * @property {string} path Relative to the root, `/`-separated.
 * @property {boolean} isDir
 * @property {boolean} ignored Matched by .gitignore & co: shown dimmed, not searched.
 */

/**
 * @typedef {Object} OpenedRoot
 * @property {string} rootId
 * @property {string} path Canonical absolute path of the root.
 */

/**
 * The opened folder. `path` and `name` are persisted; `rootId` exists only while the backend has the
 * folder open (`null` from launch until it's reopened).
 * @typedef {Object} OpenProject
 * @property {string} path Canonical absolute path.
 * @property {string} name Last path segment.
 * @property {string | null} rootId Root snapshot id; every workspace command takes it.
 */

/**
 * How turns of a project's local sessions share its checkout: one at a time, or at once.
 * @typedef {'queue' | 'parallel'} LocalTurns
 */

/**
 * The open project's `.brama/workspace.json`.
 * @typedef {Object} ProjectSettings
 * @property {LocalTurns} localTurns
 */

export {};
