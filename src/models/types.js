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
 * @property {NoticeAction} [action] A button on it (Undo); running it dismisses the notice.
 * @property {number} [timeout] How long it stays, in ms, instead of its level's.
 */

/**
 * @typedef {Object} NoticeAction
 * @property {string} label
 * @property {() => void} run
 */

/**
 * Mirrors `SessionStatus` in src-tauri/src/session/mod.rs. `waiting`: blocked on the user (a
 * permission request); `queued`: a local turn waits for another local session's turn in the same
 * checkout; `stopped`: no agent process, the next message starts one.
 * @typedef {'preparing' | 'starting' | 'idle' | 'working' | 'queued' | 'waiting' | 'stopped' | 'error'} SessionStatus
 */

/**
 * Where a session's title comes from (`TitleSource` in src-tauri/src/session/mod.rs): the first
 * prompt's words until the agent names it (`session_info_update`), or the user's rename, which the
 * agent no longer changes.
 * @typedef {'prompt' | 'agent' | 'user'} TitleSource
 */

/**
 * The status icon a session shows in its header and list row (`sessionIndicator()`). `terminal`: its
 * agent's CLI runs it in Brama's terminal; `terminal-working`: and that CLI is busy.
 * @typedef {'permission' | 'error' | 'running' | 'queued' | 'elsewhere' | 'terminal' | 'terminal-working' | 'unread'} SessionIndicator
 */

/**
 * How a session is shown in the agent column: `<chx-chat>` over ACP, or its agent's own CLI in a terminal.
 * @typedef {'chat' | 'terminal'} SessionView
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
 * @property {string | null} [agentName] Its agent's name as agents.json last gave it.
 * @property {string | null} [acpSessionId] The agent's own id of it; `null` until its agent first started.
 * @property {string | null} [activeElsewhereUntil] Until when another app (a terminal) may be running it:
 *   its agent saw activity in it that wasn't Brama's. Counts only while it doesn't run here
 *   (`isActiveElsewhere()`).
 * @property {boolean} [inTerminal] Its agent's CLI runs it in a Brama terminal; activity it reports is that CLI's.
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
 * `held`: the turn's prompt waits for a sign-in; `prompt-returned`: such a prompt was dropped unsent.
 * `cli-exited`: the session's CLI (its Terminal view) ended.
 * @typedef {{ sessionId: string, seq: number } & (
 *   { kind: 'update', payload: AcpSessionUpdate }
 *   | { kind: 'status', payload: { status: SessionStatus, message?: string | null } }
 *   | { kind: 'permission-request',
 *       payload: { requestId: string, toolCall: AcpSessionUpdate, options: AcpPermissionOption[] } }
 *   | { kind: 'turn-start', payload: Record<string, never> }
 *   | { kind: 'queued', payload: { holder: { id: string, title: string | null } } }
 *   | { kind: 'overlap', payload: { path: string, other: { id: string, title: string } } }
 *   | { kind: 'turn-end', payload: { stopReason: string } }
 *   | { kind: 'error', payload: { message: string, turn?: boolean } }
 *   | { kind: 'config-options', payload: { configOptions: AcpConfigOption[] } }
 *   | { kind: 'untrusted', payload: { launch: LaunchConfig, message: string } }
 *   | { kind: 'unconfigured', payload: { agentId: string, message: string, ran: string | null, reason?: 'removed' | 'off' } }
 *   | { kind: 'agent-outdated', payload: { message: string | null } }
 *   | { kind: 'session', payload: Session }
 *   | { kind: 'sign-in', payload: SessionSignIn | null }
 *   | { kind: 'held', payload: { prompt: PromptInput[] } }
 *   | { kind: 'prompt-returned', payload: { prompt: PromptInput[] } }
 *   | { kind: 'cli-exited', payload: TerminalExit }
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
 * How a sync went for one agent of the project (`sessions_sync`).
 * @typedef {'listed' | 'unsupported' | 'off' | 'untrusted' | 'signIn' | 'failed'} SyncOutcome
 */

/**
 * @typedef {Object} AgentSync
 * @property {string} agentId
 * @property {string} agentName
 * @property {SyncOutcome} outcome
 * @property {number | null} count `listed`: how many sessions it listed.
 * @property {string | null} error `failed`: why.
 */

/**
 * One sync of a project's sessions with its agents.
 * @typedef {Object} SyncReport
 * @property {string} projectPath
 * @property {string} startedAt
 * @property {string} endedAt
 * @property {AgentSync[]} agents
 */

/**
 * A project's sync as its session list shows it.
 * @typedef {Object} SessionSync
 * @property {boolean} running
 * @property {SyncReport | null} report The last one this launch.
 */

/**
 * `sessions://synced`: a project's sessions after a sync, for every window.
 * @typedef {Object} SessionsSynced
 * @property {string} projectPath
 * @property {Session[]} sessions
 * @property {SyncReport} report
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
 * @property {'progress' | 'error' | 'stopped' | 'info' | 'outdated' | 'queued' | 'overlap' | 'sign-in'} kind `outdated`:
 *   agents.json changed what the running agent runs; Restart picks it up. `queued`: the turn waits for
 *   `holder`'s. `overlap`: another running turn changed a file this one did, until the turn ends.
 *   `sign-in`: the agent asks for a sign-in; a prompt sent meanwhile waits for it.
 * @property {string} message
 * @property {{ id: string, title: string | null }} [holder] `queued`: the session whose turn has the checkout.
 * @property {SessionNotice} [under] `overlap`: the `info` / `outdated` notice it covers, back when it goes.
 * @property {string} [offAgent] `error`: the user turned this agent off; Turn on starts the session again.
 * @property {SessionSignIn} [signIn] `sign-in`: the agent and the ways it offers.
 */

/**
 * A session's agent asks for a sign-in (the `sign-in` session event).
 * @typedef {Object} SessionSignIn
 * @property {string} agentId
 * @property {string} agentName
 * @property {SignInMethod[]} methods
 */

/**
 * A sign-in this window started or saw (`agents://sign-in`), until it's done or cancelled.
 * @typedef {Object} SignInRun
 * @property {'waiting' | 'failed'} state
 * @property {string | null} message `failed`: why.
 * @property {LoginTab | null} terminal The login's terminal, for a terminal method.
 */

/**
 * `agents://sign-in`: how a sign-in goes.
 * @typedef {Object} SignInEvent
 * @property {string | null} projectPath `null`: the user's agents.
 * @property {string} agentId
 * @property {'waiting' | 'done' | 'failed' | 'cancelled'} state
 * @property {string | null} message `done`: "Signed in to …"; `failed`: why.
 * @property {LoginTab | null} terminal The login's terminal, for a terminal method.
 */

/**
 * An agent as `agents_list` shows it: no environment.
 * @typedef {Object} AgentSummary
 * @property {string} id
 * @property {string} name
 * @property {'user' | 'project'} scope The agents.json that chose what it runs.
 * @property {string | null} version The version installed: the one its args pin, else `agentInfo.version`
 *   from its last `initialize`.
 * @property {string | null} registryId The ACP registry entry it runs; `null`: a custom agent.
 * @property {AgentUpdate | null} update A newer version the registry has.
 * @property {boolean} enabled Not turned off by the user; only these are offered and started.
 * @property {boolean} signIn It asked to sign in and hasn't since.
 * @property {string} command What it runs, for the edit form.
 * @property {string[]} args
 * @property {AgentTerminal | null} [terminal] Its CLI, for a session's Terminal view; `null`: it has none.
 */

/**
 * What an agent's CLI can do for a session's Terminal view.
 * @typedef {Object} AgentTerminal
 * @property {boolean} resume It continues a session by its ACP id.
 * @property {boolean} new It starts a session under an id Brama chooses.
 */

/**
 * A newer version of an agent in the ACP registry.
 * @typedef {Object} AgentUpdate
 * @property {string} to
 * @property {boolean} pin The installed version isn't known: Update pins the registry's ("Pin latest").
 */

/** @typedef {'all' | 'updates' | 'off'} AgentsFilter The Agents tab's filter chip. */

/**
 * What the Agents tab asks the backend for (`agents_view`). In memory.
 * @typedef {Object} AgentsQuery
 * @property {string} query
 * @property {AgentsFilter} filter
 */

/**
 * One of an agent's ways to sign in (ACP `authMethods`). `agent`: the agent signs in itself (it
 * opens the browser); `terminal` / `command`: a login runs in a Terminal tab.
 * @typedef {Object} SignInMethod
 * @property {string} id
 * @property {string} name
 * @property {string | null} description
 * @property {'agent' | 'terminal' | 'command'} kind
 * @property {string | null} label The login terminal's title.
 * @property {{ provider: string | null } | null} apiKey It reads a key from the agent's environment.
 */

/**
 * What a probe learned (`agents_probe_options`): the agent's options, or that it asks to sign in first.
 * @typedef {AcpConfigOption[] | { signIn: SignInMethod[] }} ProbedOptions
 */

/**
 * A sign-in's login running in a terminal the backend started (`agents_sign_in` of a `terminal` /
 * `command` method): exit 0 signs in, closing its tab cancels.
 * @typedef {Object} LoginTab
 * @property {string} terminalId
 * @property {string} title The method's label, else its name.
 * @property {string} commandLine What it runs, without its environment: the tab's tooltip.
 */

/**
 * An agent that asked to sign in, or is signing in.
 * @typedef {Object} AgentSignIn
 * @property {SignInMethod[]} methods
 * @property {boolean} pending A sign-in runs.
 */

/**
 * An installed agent as the Agents tab shows it.
 * @typedef {Object} AgentRow
 * @property {string} id
 * @property {string} name
 * @property {'user' | 'project'} scope
 * @property {boolean} enabled
 * @property {boolean} isDefault
 * @property {string} command
 * @property {string[]} args
 * @property {string | null} version
 * @property {AgentUpdate | null} update
 * @property {boolean} updating An update runs: from its write to the end of its download.
 * @property {'ready' | 'notStarted' | 'off' | 'signIn'} status
 * @property {AgentSignIn | null} signIn With status `signIn`.
 * @property {[number, number][]} nameMatches Where the search matched the name, `[start, end)` in UTF-16 units.
 * @property {AgentTerminal | null} terminal Its CLI, for a session's Terminal view; `null`: it has none.
 * @property {string | null} description The registry's description of what it runs.
 */

/**
 * A registry agent that isn't installed.
 * @typedef {Object} RegistryRow
 * @property {string} id
 * @property {string} name
 * @property {string} vendor
 * @property {string} description
 * @property {string} commandLine What Add writes.
 * @property {[number, number][]} nameMatches
 */

/**
 * The last check of the ACP registry.
 * @typedef {Object} RegistryState
 * @property {string | null} checkedAt ISO 8601; `null`: never, the bundled list is in use.
 * @property {boolean} offline The last check failed.
 * @property {boolean} checking
 */

/**
 * `agents_view`: the Agents tab's data, searched and filtered by the backend.
 * @typedef {Object} AgentsView
 * @property {AgentRow[]} installed
 * @property {AgentRow[]} userAgents With a project: the user's own agents it lacks (All only).
 * @property {RegistryRow[]} registry Registry agents not installed (All only).
 * @property {{ all: number, updates: number, off: number }} counts Ignore the search.
 * @property {string | null} defaultAgent
 * @property {string[]} errors
 * @property {RegistryState} registryState
 */

/**
 * What the Agents tab is to show once open: the registry's agents to add, or an agent's row.
 * @typedef {Object} AgentsReveal
 * @property {boolean} [add]
 * @property {string} [agentId]
 */

/**
 * An ACP registry agent the add form offers, with its pinned `npx` launch.
 * @typedef {Object} KnownAgent
 * @property {string} id Its registry id, also its id in agents.json when that's free.
 * @property {string} name
 * @property {string} command
 * @property {string[]} args
 */

/**
 * An ACP agent added in Settings (`agents_add`), written to the user's agents.json. A `known` one
 * runs its registry launch unless `command` replaces it.
 * @typedef {Object} NewAgent
 * @property {string} name
 * @property {string} [known] A `KnownAgent` id.
 * @property {string} [command]
 * @property {string[]} [args]
 */

/**
 * Where the Settings tab is to scroll.
 * @typedef {Object} SettingsReveal
 * @property {SettingsAnchor} section
 */

/** @typedef {'theme' | 'editor'} SettingsAnchor A section of the Settings tab, as its navigation lists them. */

/**
 * `agents_list`: the agents configured for a project, the disabled too.
 * @typedef {Object} AgentList
 * @property {AgentSummary[]} agents
 * @property {string | null} defaultAgent
 * @property {KnownAgent[]} known The well-known agents Settings offers to add.
 * @property {AgentSummary[]} userAgents With a project open: the user's own agents it lacks, which apply only
 *   with no project open; Settings offers to copy them in.
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
 * A worktree session's folder, open as a backend root for the Files tree.
 * @typedef {Object} SessionRoot
 * @property {string} sessionId
 * @property {string} rootId
 * @property {string} path Canonical; the session's folder (`Session.folder`).
 * @property {string} label The worktree's folder name, the tree's root row.
 */

/**
 * The folder the Files tree lists.
 * @typedef {Object} TreeRoot
 * @property {string | null} rootId `null` while none is open.
 * @property {string | null} path
 * @property {string | null} label A root row's: the worktree's name; `null` for the project (no row).
 */

/**
 * What Apply Locally did with a worktree session's work.
 * @typedef {{ outcome: 'empty' | 'clean' } | { outcome: 'conflicts', conflicts: string[] }} ApplyResult
 *   `conflicts`: files (relative to the repository) left with conflict markers by a three-way merge.
 */

/**
 * How turns of a project's local sessions share its checkout: one at a time, or at once.
 * @typedef {'queue' | 'parallel'} LocalTurns
 */

/**
 * The open project's `.brama/workspace.json`.
 * @typedef {Object} WorkspaceSettings
 * @property {'local' | 'worktree'} defaultMode The run target a new session starts with.
 * @property {LocalTurns} localTurns
 */

/**
 * What a main-column tab shows: a file, or a view (Settings; Changes, every changed file's diff;
 * Terminal; Browser).
 * @typedef {'file' | 'settings' | 'agents' | 'changes' | 'session-changes' | 'terminal' | 'browser'} TabKind
 */

/**
 * Which view renders a tab's content: a file's by its extension (`code` for any other), a view tab's
 * by its kind. Picked by `TabContentController`.
 * @typedef {'code' | 'markdown' | 'image' | 'settings' | 'agents' | 'changes' | 'session-changes' | 'terminal' | 'browser'} ContentKind
 */

/**
 * Open editor tabs.
 * @typedef {Object} EditorTabs
 * @property {string[]} paths Tab ids in strip order: a file's absolute path, or a view's id
 *   (`SETTINGS_TAB_ID`, `CHANGES_TAB_ID`, `BROWSER_TAB_ID`, `terminalTabId()`); see `parseTabId()` in `stores/editor.js`.
 * @property {string | null} active Tab id.
 * @property {string[]} pinned Pinned tab ids, the first tabs of `paths` in the same order. Close Others
 *   and Close All leave them open.
 */

/** @typedef {'mac' | 'windows' | 'linux'} Platform */

/**
 * A drag of files from the OS over the window, as the webview reports it (`onFileDrag` in
 * `services/ipc.js`). `position` is relative to the webview's top-left corner: physical pixels on
 * Windows, logical ones on macOS and Linux (`toCssPoint()` in `models/file-drop.js`).
 * @typedef {(
 *   | { type: 'enter' | 'drop', paths: string[], position: { x: number, y: number } }
 *   | { type: 'over', position: { x: number, y: number } }
 *   | { type: 'leave' }
 * )} FileDrag
 */

/**
 * Files dropped from the OS on a drop target (`fileDrop`'s `drop` event): the column that renders
 * `target` handles it.
 * @typedef {Object} FileDrop
 * @property {Element} target The innermost drop target under the pointer (`acp-terminal`, `acp-chat`).
 * @property {string[]} paths Absolute.
 */

/**
 * A dropped path and what it is on disk (`dropped_kinds`): `other` when it's gone or neither a
 * regular file nor a folder.
 * @typedef {Object} DroppedEntry
 * @property {string} path Absolute.
 * @property {'file' | 'folder' | 'other'} kind
 */

/**
 * A file or folder for the composer, as a chip like an `@` pick (`AcpChat.insertFiles()`).
 * @typedef {Object} ChatFile
 * @property {string} path Relative to the session's folder, or absolute outside it.
 * @property {boolean} folder
 */

/**
 * Files dropped on the chat, sorted (`chatDropOf()` in `models/file-drop.js`).
 * @typedef {Object} ChatDrop
 * @property {ChatFile[]} files Chips.
 * @property {{ path: string, name: string, mime: string }[]} images Attachments.
 */

/** @typedef {'starting' | 'running' | 'exited' | 'failed'} TerminalStatus */

/**
 * How a terminal's shell ended; mirrors `terminal::TerminalEvent::Exit`.
 * @typedef {Object} TerminalExit
 * @property {number | null} code
 * @property {string | null} signal Its name (`SIGKILL`) when a signal ended it.
 */

/**
 * A terminal tab's shell (`$terminals`).
 * @typedef {Object} TerminalInfo
 * @property {string} cwd Where it starts; once started, where it did.
 * @property {string | null} fallback Where it starts when `cwd` doesn't exist.
 * @property {string} label The tab's title: the folder's name, then `zsh — my-app`.
 * @property {string | null} title A title the shell set (OSC 0 / 2), shown instead of `label`.
 * @property {string | null} projectPath The project whose tabs hold it; `null` for no project's.
 * @property {TerminalStatus} status
 * @property {TerminalExit | null} exit Set once `exited`.
 * @property {string | null} error Why it didn't start, once `failed`.
 * @property {string | null} login A sign-in's login (what it runs, the tab's tooltip): the backend
 *   started it, and the sign-in, not Restart, runs it again.
 * @property {string | null} [sessionId] A session's CLI (its Terminal view): never a tab; the backend
 *   started it, and Restart starts the CLI again.
 */

/**
 * What the backend started; mirrors `terminal::Opened`.
 * @typedef {Object} TerminalOpened
 * @property {string} shell The shell's file name (`zsh`).
 * @property {string} cwd The folder it started in.
 */

/**
 * A terminal running something other than its shell; mirrors `terminal::Busy`.
 * @typedef {Object} TerminalBusy
 * @property {string} id
 * @property {string} process The foreground program's name.
 */

/**
 * The stream between a terminal view and its shell (`connect()` in `services/terminals.js`).
 * @typedef {Object} TerminalLink
 * @property {(data: string | Uint8Array) => void} write Input for the shell: typed text, or raw bytes.
 * @property {(cols: number, rows: number) => void} resize
 * @property {() => void} dispose The view is gone; the shell keeps running.
 */

/**
 * Where a terminal view's output goes.
 * @typedef {Object} TerminalSink
 * @property {(bytes: Uint8Array, done: () => void) => void} output `done` once drawn.
 * @property {() => void} reset Clear the screen: a fresh shell starts.
 * @property {(exit: TerminalExit) => void} exit The shell ended (after its output).
 */

/**
 * Starts (or reattaches to) a terminal's shell at a size and streams it into `sink`.
 * @typedef {(id: string, size: { cols: number, rows: number }, sink: TerminalSink) => TerminalLink} TerminalConnect
 */

/**
 * The terminals among `ids` that run a program other than their shell.
 * @typedef {(ids: string[]) => Promise<TerminalBusy[]>} TerminalBusyQuery
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
 * What Quick Open lists: files, files and folders, or folders only.
 * @typedef {'files' | 'all' | 'dirs'} QuickOpenKind
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
 * @property {number} offset UTF-16 units cut from the line's start (0 unless it was long); a
 *   match's 1-based column is `offset + start + 1`.
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
 * One Find in Files match, a row of `<acp-search-results>`.
 * @typedef {Object} SearchMatchRow
 * @property {string} key `path:line:start`, unique per match.
 * @property {string} path Root-relative.
 * @property {number} line 1-based.
 * @property {number} column 1-based, in UTF-16 units of the whole line.
 * @property {number} length In UTF-16 units.
 * @property {string} text The line (or its window) as the backend sent it.
 * @property {number} start `[start, end)` of the match in `text`.
 * @property {number} end
 */

/**
 * What the search dialog searches for; `folder` root-relative, `''` for the whole project.
 * @typedef {Object} SearchDialogState
 * @property {string} query
 * @property {boolean} caseSensitive
 * @property {boolean} wholeWord
 * @property {boolean} regex
 * @property {string} folder
 * @property {string} mask Comma-separated globs, `!` excludes.
 */

/**
 * A project's search dialog state with its recent queries, most recent first.
 * @typedef {SearchDialogState & { recent: string[] }} ProjectSearchState
 */

/**
 * The search dialog's layout, shared by all windows. Splits are percentages, 20–80.
 * @typedef {Object} SearchDialogPrefs
 * @property {'bottom' | 'right' | 'none'} preview
 * @property {'flat' | 'grouped'} view
 * @property {number} splitBottom
 * @property {number} splitRight
 */

/**
 * The file the search dialog previews, or why it couldn't be read.
 * @typedef {{ path: string, content: string } | { path: string, error: string }} SearchPreview
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
 * @property {string} [extraLabel] A third action, between the other two; only `choose()` tells it apart.
 * @property {boolean} [destructive] Colors the confirm action as an error.
 * @property {'center' | 'top'} [placement] Where in the window; defaults to `center`.
 */

/**
 * What `<acp-confirm-dialog>`'s `choose()` resolves to: the confirm action, the extra one, or neither.
 * @typedef {'confirm' | 'extra' | 'cancel'} ConfirmChoice
 */

/**
 * An agent the composer can start a session with; Brama's list, not ACP's.
 * @typedef {Object} AgentInfo
 * @property {string} id
 * @property {string} name
 * @property {boolean} [removed] No longer in agents.json (a started session's).
 * @property {boolean} [off] Turned off by the user: not offered, not started.
 * @property {boolean} [signIn] It asked to sign in: offered still, since picking it is how one signs in.
 */

/** @typedef {'loading' | 'failed'} AgentOptionsStatus Asking an agent for its config options (a probe), or that failed. */

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
 * The context window as ACP's last `usage_update` reported it (its cost isn't kept).
 * @typedef {Object} ContextUsage
 * @property {number} used Tokens.
 * @property {number} size Tokens.
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
 * @property {RunTarget} runTarget
 * @property {boolean} [runTargetPicked] The user picked the run target; until then a draft's is the
 *   project's default (`$workspaceSettings`).
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
 * @property {boolean} changedOnDisk With a draft: the file on disk is no longer `content`, the text the
 *   draft started from. Save then asks before writing over it.
 * @property {boolean} deletedOnDisk The file was deleted since it was read; the tab still shows it,
 *   and a save creates it again.
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
