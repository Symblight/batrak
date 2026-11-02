/**
 * Payload of the `workspace://changed` event. All paths are relative.
 * @typedef {Object} WorkspaceChanges
 * @property {string} rootId
 * @property {string[]} dirs Directories whose child list changed (`''` = root).
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} modified
 * @property {boolean} git The repository's HEAD, index or refs changed.
 */

/**
 * Branch of the root's repository; mirrors `git::repo::RepoState`.
 * @typedef {Object} GitRepoState
 * @property {string | null} branch `null` when detached.
 * @property {string | null} sha `null` before the first commit.
 * @property {boolean} detached
 * @property {string | null} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {GitRemoteInfo | null} remote The remote the branch syncs with; `null` when detached or without remotes.
 * @property {boolean} hasRemotes The repository has a remote at all ("No remote" against "No upstream").
 * @property {number | null} fetchedAt Unix ms of the last fetch; `null` if it never ran.
 */

/**
 * @typedef {Object} GitRemoteInfo
 * @property {string} name
 * @property {string} url Without credentials.
 * @property {{ owner: string, repo: string } | null} github Set for a github.com remote.
 */

/**
 * What the header's remote chip shows for a branch.
 * @typedef {Object} GitRemoteChip
 * @property {'none' | 'publish' | 'synced' | 'push' | 'pull' | 'diverged'} id
 * @property {string} label
 * @property {string} icon Material icon name; empty for none.
 * @property {string} tooltip
 */

/** @typedef {'modified' | 'added' | 'deleted' | 'renamed' | 'typeChanged' | 'untracked' | 'conflicted'} GitFileKind */

/**
 * A changed file; mirrors `git::repo::FileStatus`.
 * @typedef {Object} GitFileStatus
 * @property {string} path A file, relative to the root; untracked folders are listed file by file.
 * @property {GitFileKind} kind
 * @property {boolean} staged
 * @property {boolean} unstaged
 * @property {string | null} origPath Rename source.
 * @property {number | null} added Lines added against HEAD; `null` when unknown (binary, too large).
 * @property {number | null} removed Lines removed against HEAD.
 */

/**
 * @typedef {Object} GitStatus
 * @property {GitRepoState} repo
 * @property {GitFileStatus[]} files
 */

/**
 * Reply of `git_status`; mirrors `git::cache::StatusReply`.
 * @typedef {Object} GitStatusReply
 * @property {number} version Changes whenever the status does; passed back as `since`.
 * @property {boolean} unchanged The `since` version is still current: `status` is left out.
 * @property {GitStatus | null} status `null` outside a repository, or when `unchanged`.
 */

/**
 * Reply of `git_commit`; mirrors `git::commit::Committed`.
 * @typedef {Object} GitCommitted
 * @property {string} sha Abbreviated.
 * @property {string} summary First line of the message.
 */

/**
 * Branch of the active root (`$gitRepo`), kept current while a project is open.
 * @typedef {Object} GitRepoView
 * @property {GitRepoState | null} repo `null` outside a repository or until first read.
 * @property {string | null} error Why it couldn't be read, e.g. "git not found".
 */

/**
 * Changed files of the active root (`$gitChanges`). Kept when the Changes views close; checked
 * (cheaply, unless something changed) whenever one is shown again.
 * @typedef {Object} GitChangesView
 * @property {GitFileStatus[]} files A new array only when the status changed.
 * @property {boolean} loaded A status of this root has arrived.
 * @property {boolean} loading A check is in flight.
 * @property {string | null} error
 */

export {};
