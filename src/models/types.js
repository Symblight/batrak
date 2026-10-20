/**
 * Shared data model (JSDoc only). Session mirrors the Rust struct in
 * src-tauri/src/session/mod.rs field by field.
 */

/**
 * Project listed in the session column (`$projects`); only `name` and `path` are persisted.
 * @typedef {Object} Project
 * @property {string} id Same as `path`; sessions refer to it by `projectId`.
 * @property {string} name Last path segment.
 * @property {string} path Canonical absolute path.
 */

/**
 * Level of a frontend line in the app log (`write_log`).
 * @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel
 */

/**
 * @typedef {'error' | 'warn' | 'info'} NoticeLevel
 */

/**
 * Snackbar in the bottom-end corner (`$notices`).
 * @typedef {Object} Notice
 * @property {number} id
 * @property {NoticeLevel} level
 * @property {string} message
 * @property {number} count Times the same message came in while shown.
 */

/**
 * Mirrors `SessionStatus` in src-tauri/src/session/mod.rs. `waiting`: blocked on the user (a
 * permission request); `stopped`: no agent process, the next message starts one.
 * @typedef {'preparing' | 'starting' | 'idle' | 'working' | 'waiting' | 'stopped' | 'error'} SessionStatus
 */

/**
 * Where a session's title comes from (`TitleSource` in src-tauri/src/session/mod.rs): the first
 * prompt's words until the agent names it (`session_info_update`), or the user's rename, which the
 * agent no longer changes.
 * @typedef {'prompt' | 'agent' | 'user'} TitleSource
 */

/**
 * The status icon a session shows in its header and list row (`sessionIndicator()`).
 * @typedef {'permission' | 'error' | 'running' | 'unread'} SessionIndicator
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} projectId
 * @property {string} title
 * @property {TitleSource} titleSource
 * @property {string | null} agentTitle The title the agent last gave it, kept under a user's title.
 * @property {SessionStatus} status
 * @property {string} agentId
 * @property {Record<string, string>} config The agent's config options (model, thought level, mode) as
 *   last chosen or reported, by id; the agent is set to them whenever it starts.
 * @property {RunTargetKind} mode Where the agent runs; fixed for the session's life.
 * @property {string} folder Where the agent works: the project, or the project's folder in its worktree.
 * @property {string | null} worktreePath `worktree` only: its root.
 * @property {string | null} branch `worktree` only: the session's own branch.
 * @property {string | null} baseCommit `worktree` only: the commit it started from.
 * @property {string} createdAt
 * @property {string} lastActivityAt The last prompt or turn end, else `createdAt`; the list's order.
 */

/**
 * ACP content block, as far as the chat reads it.
 * @typedef {{ type: 'text', text: string } | { type: string, text?: string, uri?: string, name?: string }} AcpContent
 */

/**
 * An ACP `SessionUpdate` as the agent sent it; `sessionUpdate` names its kind (`agent_message_chunk`,
 * `agent_thought_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `plan`, …). Only the
 * fields the chat reads are typed.
 * @typedef {Object} AcpSessionUpdate
 * @property {string} sessionUpdate
 * @property {AcpContent} [content] Message, thought and user chunks.
 * @property {string} [toolCallId]
 * @property {string | null} [title]
 * @property {string | null} [kind]
 * @property {'pending' | 'in_progress' | 'completed' | 'failed' | null} [status]
 * @property {{ path: string, line?: number | null }[] | null} [locations]
 * @property {{ content: string, priority?: string, status?: 'pending' | 'in_progress' | 'completed' }[]} [entries] `plan`.
 * @property {number} [used] `usage_update`: tokens in context.
 * @property {number} [size] `usage_update`: the context window, tokens.
 * @property {{ amount: number, currency: string } | null} [cost] `usage_update`: the session's so far.
 */

/**
 * An ACP `SessionConfigOption` as the agent sent it (`config-options` events); see
 * `normalizeOptions()` for what the composer keeps.
 * @typedef {{ id: string, name: string, type: string, category?: string, currentValue?: unknown,
 *   options?: unknown[] }} AcpConfigOption
 */

/**
 * ACP `PermissionOption`.
 * @typedef {{ optionId: string, name: string, kind: string }} AcpPermissionOption
 */

/**
 * A session event from the backend's channel; `seq` is monotonic per session. `turn-end` carries
 * ACP's `stopReason` (`end_turn`, `cancelled`, …); an `error` with `turn` ended the running turn.
 * @typedef {{ sessionId: string, seq: number } & (
 *   { kind: 'update', payload: AcpSessionUpdate }
 *   | { kind: 'status', payload: { status: SessionStatus, message?: string | null } }
 *   | { kind: 'permission-request',
 *       payload: { requestId: string, toolCall: AcpSessionUpdate, options: AcpPermissionOption[] } }
 *   | { kind: 'turn-start', payload: Record<string, never> }
 *   | { kind: 'turn-end', payload: { stopReason: string } }
 *   | { kind: 'error', payload: { message: string, turn?: boolean } }
 *   | { kind: 'config-options', payload: { configOptions: AcpConfigOption[] } }
 *   | { kind: 'untrusted', payload: { launch: LaunchConfig, message: string } }
 *   | { kind: 'session', payload: Session }
 * )} SessionEnvelope
 */

/**
 * A project's agent that runs what its agents.json chose, waiting for the user's trust
 * (`agents_untrusted`).
 * @typedef {Object} UntrustedAgent
 * @property {string} name
 * @property {LaunchConfig} launch
 */

/**
 * What the trust dialog asks about: the project's agents waiting for trust.
 * @typedef {Object} TrustPrompt
 * @property {string} projectPath
 * @property {UntrustedAgent[]} agents
 */

/**
 * What a session start runs, as the user trusts it (`agents_trust`): the agent's command line and
 * env templates, and the MCP servers it's told to start.
 * @typedef {Object} LaunchConfig
 * @property {string} agentId
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {unknown[]} mcpServers
 */

/**
 * One line of a session's recorded conversation (`session_history`), oldest first.
 * @typedef {{ kind: 'prompt', prompt: PromptInput[], at: string }
 *   | { kind: 'update', update: AcpSessionUpdate }
 *   | { kind: 'turn-end', stopReason: string, message?: string }} TranscriptEntry
 */

/**
 * One piece of a prompt for `session_send_prompt`; paths are relative to the project.
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'mention', path: string }
 *   | { type: 'selection', path: string, fromLine: number, toLine: number }} PromptInput
 */

/**
 * An agent's `session/request_permission`, waiting for the user's answer.
 * @typedef {Object} PermissionRequest
 * @property {string} requestId
 * @property {string | null} toolCallId
 * @property {string} title What the agent wants to do.
 * @property {AcpPermissionOption[]} options
 */

/**
 * What the chat says about a session above its composer: the agent starting, an error (with
 * Restart and Open log), the agent stopped (with Resume), or information until dismissed.
 * @typedef {Object} SessionNotice
 * @property {'progress' | 'error' | 'stopped' | 'info'} kind
 * @property {string} message
 */

/**
 * `agents_list`: the agents configured for a project, no command or environment.
 * @typedef {Object} AgentList
 * @property {{ id: string, name: string }[]} agents
 * @property {string | null} defaultAgent
 * @property {string[]} errors Files that don't parse (`file:line:column: message`); their last valid version is used.
 */

/**
 * @typedef {Object} Checkpoint
 * @property {string} id
 * @property {string} sessionId
 * @property {string} commit
 * @property {string} createdAt
 */

/**
 * @typedef {Object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted'} kind
 */

/**
 * @typedef {Object} Instruction
 * @property {string} id
 * @property {string} sessionId
 * @property {string} text
 * @property {string} createdAt
 */

/**
 * Workspace snapshot entry; mirrors `workspace::snapshot::Entry`.
 * @typedef {Object} WorkspaceEntry
 * @property {string} name
 * @property {string} path Relative to the root, `/`-separated.
 * @property {boolean} isDir
 * @property {boolean} ignored Matched by .gitignore & co: shown dimmed, not searched.
 * @property {number} size
 * @property {number} mtime Milliseconds since the Unix epoch.
 */

/**
 * @typedef {Object} OpenedRoot
 * @property {string} rootId
 * @property {string} path Canonical absolute path of the root.
 */

/**
 * The opened folder. `path` and `name` are persisted; `rootId` exists only while the backend has the
 * folder open (`null` from launch until it's reopened).
 * @typedef {Object} Workspace
 * @property {string} path Canonical absolute path.
 * @property {string} name Last path segment.
 * @property {string | null} rootId Workspace snapshot id; every workspace command takes it.
 */

/**
 * A worktree session's folder: its files open in tabs of the project, beside the project's own.
 * @typedef {Object} WorktreeFolder
 * @property {string} sessionId
 * @property {string} projectId
 * @property {string} folder The project's folder in the worktree (`Session.folder`).
 * @property {string} branch
 * @property {string} title The session's.
 */

/**
 * What Apply Locally did with a worktree session's work.
 * @typedef {{ outcome: 'empty' | 'clean' } | { outcome: 'conflicts', conflicts: string[] }} ApplyResult
 *   `conflicts`: files (relative to the repository) left with conflict markers by a three-way merge.
 */

/**
 * The open project's `.brama/workspace.json`.
 * @typedef {Object} WorkspaceSettings
 * @property {'local' | 'worktree'} defaultMode The run target a new session starts with.
 */

/**
 * What a main-column tab shows: a file, or a view (Settings; Changes, every changed file's diff;
 * Terminal; Browser).
 * @typedef {'file' | 'settings' | 'changes' | 'session-changes' | 'terminal' | 'browser'} TabKind
 */

/**
 * Which view renders a tab's content: a file's by its extension (`code` for any other), a view tab's
 * by its kind. Picked by `TabContentController`.
 * @typedef {'code' | 'markdown' | 'image' | 'settings' | 'changes' | 'session-changes' | 'terminal' | 'browser'} ContentKind
 */

/**
 * Open editor tabs.
 * @typedef {Object} EditorTabs
 * @property {string[]} paths Tab ids in strip order: a file's absolute path, or a view's id
 *   (`SETTINGS_TAB_ID`, `CHANGES_TAB_ID`, `TERMINAL_TAB_ID`, `BROWSER_TAB_ID`); see `parseTabId()` in `stores/editor.js`.
 * @property {string | null} active Tab id.
 * @property {string[]} pinned Pinned tab ids, the first tabs of `paths` in the same order. Close Others
 *   and Close All leave them open.
 */

/**
 * Column width in px by `acp-resize-handle` name (unique app-wide); a missing column uses its CSS default.
 * @typedef {Record<string, number>} ColumnWidths
 */

/**
 * Names of the columns hidden from the toolbar (`session`, `side`), as in `ColumnWidths`.
 * @typedef {string[]} HiddenColumns
 */

/** @typedef {'light' | 'dark' | 'system'} Appearance */

/**
 * An installed font family; mirrors `commands::fonts::FontFamily`.
 * @typedef {Object} FontFamily
 * @property {string} family
 * @property {boolean} monospace Any face of it is fixed-pitch.
 */

/**
 * About Brama; mirrors `commands::about::AboutInfo`.
 * @typedef {Object} AboutInfo
 * @property {string} version
 * @property {string} os Name and version, e.g. `macOS 26.1`.
 * @property {string} arch
 * @property {string | null} logDir
 */

/**
 * App preferences, shared by every window.
 * @typedef {Object} Settings
 * @property {Appearance} appearance `system` follows the OS.
 * @property {string} accent Seed colour of the MD3 palette, `#RRGGBB`.
 * @property {string | null} editorFont Code editor font family; `null` keeps the editor's own stack.
 * @property {number} editorFontSize Code editor font size in px; the line height follows it.
 */

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

/**
 * @typedef {Object} QuickOpenItem
 * @property {string} path Relative.
 * @property {string} name
 * @property {boolean} isDir
 * @property {number[]} indices Matched characters in `path` (code points), ascending.
 */

/**
 * @typedef {Object} QuickOpenResult
 * @property {QuickOpenItem[]} items
 * @property {boolean} cancelled Superseded by a newer query.
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string} query
 * @property {boolean} caseSensitive
 * @property {boolean} wholeWord
 * @property {boolean} regex
 * @property {string} include Comma-separated globs.
 * @property {string} exclude Comma-separated globs.
 */

/**
 * @typedef {Object} LineMatch
 * @property {number} line 1-based.
 * @property {string} text
 * @property {[number, number][]} ranges `[start, end)` in UTF-16 code units of `text`.
 */

/**
 * A file's Find in Files matches.
 * @typedef {Object} SearchFileResult
 * @property {string} path Root-relative.
 * @property {LineMatch[]} matches
 */

/**
 * Streamed Find in Files message; mirrors `workspace::search::SearchEvent`.
 * @typedef {{ kind: 'file', path: string, matches: LineMatch[] }
 *   | { kind: 'done', total: number, limitHit: boolean, cancelled: boolean }
 *   | { kind: 'error', message: string }} SearchEvent
 */

/**
 * A line comment for the agent, as the editors show it (`<cdx-comments>`, controlled). Queued until
 * Send to agent, which removes it. `fromLine`: first line of the selection it was made on (`line` is
 * the last, where the editor shows it); absent for one line.
 * @typedef {import('@symblight/code-editor').CdxThread & { fromLine?: number }} AgentThread
 */

/**
 * A queued comment, one per thread (comments are `mode="single"`), in Send-to-agent order.
 * @typedef {Object} QueuedComment
 * @property {string} path File, absolute.
 * @property {string} threadId
 * @property {string} commentId
 * @property {number} fromLine 1-based; `line` for a one-line comment.
 * @property {number} line 1-based, the last line.
 * @property {string} lineText
 * @property {string} body
 */

/**
 * Something from the code going into the chat's composer as a file chip labelled `path:fromLine-toLine`
 * (`path:line` for one line): a selection (`body` empty, the chip goes in at the caret) or a comment
 * (its own line: chip, then `body`).
 * @typedef {Object} ChatInsert
 * @property {string} path Absolute.
 * @property {number} fromLine 1-based.
 * @property {number} toLine 1-based.
 * @property {string} body
 */

/**
 * A comment to scroll to: the editor showing its file reveals it, opening the file first if needed.
 * @typedef {Object} CommentFocus
 * @property {string} path Absolute.
 * @property {string} threadId
 */

/**
 * What `<acp-confirm-dialog>` asks.
 * @typedef {Object} ConfirmOptions
 * @property {string} headline
 * @property {string} message
 * @property {string} [detail] Secondary line under the message.
 * @property {string} [confirmLabel] Defaults to `OK`.
 * @property {string} [cancelLabel] Defaults to `Cancel`.
 * @property {boolean} [destructive] Colors the confirm action as an error.
 * @property {'center' | 'top'} [placement] Where in the window; defaults to `center`.
 */

/**
 * An agent the composer can start a session with; Brama's list, not ACP's.
 * @typedef {Object} AgentInfo
 * @property {string} id
 * @property {string} name
 * @property {string} glyph One or two letters for its badge.
 */

/** @typedef {AgentInfo & { configOptions: ConfigOption[] }} CatalogAgent An agent with its config options as last seen. */

/**
 * One value of an ACP session config option.
 * @typedef {Object} ConfigOptionValue
 * @property {string} value
 * @property {string} name
 * @property {string} [description]
 */

/**
 * An ACP session config option (`configOptions` of `session/new`, `config_option_update`), kept in
 * the agent's order. The composer finds its controls by `category`.
 * @typedef {Object} ConfigOption
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {'model' | 'thought_level' | 'mode' | string} [category]
 * @property {'select'} type
 * @property {string} currentValue
 * @property {ConfigOptionValue[]} options
 */

/**
 * The context window as ACP's last `usage_update` reported it.
 * @typedef {Object} ContextUsage
 * @property {number} used Tokens.
 * @property {number} size Tokens.
 * @property {{ amount: number, currency: string }} [cost] The session's so far.
 */

/**
 * @typedef {'local' | 'worktree' | 'docker'} RunTargetKind
 */

/**
 * Where a session runs: picked before it starts, fixed after.
 * @typedef {Object} RunTarget
 * @property {RunTargetKind} kind
 * @property {string | null} branch `null`: the project's current branch.
 */

/**
 * The agent composer's state for the chat (`$composer`).
 * @typedef {Object} ComposerState
 * @property {string | null} agentId `null` while the project configures no agent; a started session's is set.
 * @property {ConfigOption[]} configOptions The agent's, as it last reported them (shown with `chosen` applied).
 * @property {Record<string, string>} chosen Values the user picked that the agent hasn't confirmed yet
 *   (picked before it started, or on their way), by config option id.
 * @property {ContextUsage | null} usage `null` until the agent reports one.
 * @property {RunTarget} runTarget
 * @property {boolean} started After the first message: the agent and run target are fixed.
 */

/**
 * An open tab with what it shows; which tabs are open, and the active one, live in `$editorTabs`.
 * @typedef {Object} EditorTab
 * @property {string} id Its id in `$editorTabs`.
 * @property {TabKind} kind
 * @property {string} path The file, absolute; `''` for a view (Settings, Changes, Terminal, Browser).
 * @property {string} content
 * @property {string} error
 * @property {boolean} loaded Whether `content` and `baseline` (or `image`) are current. Only the active
 *   tab is read (and only when its view shows the file, `readsFile()`); the others are read, or re-read
 *   after a change on disk, when they become active.
 * @property {Blob | null} image An image tab's bytes, typed by its extension; `null` until read.
 * @property {string | null} baseline The file at HEAD, for the diff gutter; `null` when it has none.
 * @property {string | null} draft Unsaved edits (only editable files, `isAgentsFile()`); `null` when
 *   the editor shows what's on disk. A change on disk doesn't replace it.
 */

/**
 * An expanded file's diff in the Changes tab: the file now against the file at HEAD.
 * @typedef {Object} FileDiff
 * @property {string} content `''` for a deleted file.
 * @property {string} baseline `''` for a new file.
 * @property {string} error
 * @property {boolean} loading
 */

export {};
