/**
 * Shared data model (JSDoc only). Session mirrors the Rust struct in
 * src-tauri/src/session/mod.rs field by field.
 */

/** @typedef {import('../composer/types.js').AcpConfigOption} AcpConfigOption */
/** @typedef {import('../agents/types.js').LaunchConfig} LaunchConfig */
/** @typedef {import('../composer/types.js').RunTargetKind} RunTargetKind */
/** @typedef {import('../agents/types.js').SessionSignIn} SessionSignIn */
/** @typedef {import('../terminals/types.js').TerminalExit} TerminalExit */
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
 * @typedef {'permission' | 'error' | 'running' | 'queued' | 'elsewhere' | 'terminal' | 'terminal-working'} SessionIndicator
 */

/**
 * When the user last saw a session (`$sessionReads`, `session-read.js`), or `null` for one marked
 * unread by hand.
 * @typedef {Object} SessionRead
 * @property {string | null} seen ISO time.
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
 * @property {string | null} [workspaceId] Its workspace; `null` or absent for Main.
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
 * @property {AcpContent | AcpContent[]} [content] Message, thought and user chunks; `session_message`: its blocks.
 * @property {string} [toolCallId]
 * @property {string | null} [title]
 * @property {string | null} [kind]
 * @property {'pending' | 'in_progress' | 'completed' | 'failed' | null} [status]
 * @property {{ path: string, line?: number | null }[] | null} [locations]
 * @property {{ content: string, priority?: string, status?: 'pending' | 'in_progress' | 'completed' }[]} [entries] `plan`.
 * @property {number} [used] `usage_update`: tokens in context.
 * @property {number} [size] `usage_update`: the context window, tokens.
 * @property {{ amount: number, currency: string } | null} [cost] `usage_update`: the session's so far.
 * @property {string} [subagentId] Added by the backend: the subagent (its ACP session id) whose
 *   update this is, on the chat's channel; absent for the chat's own.
 * @property {string} [sessionId] `subagent_update`: the subagent it announces or patches.
 * @property {string | null} [description] `subagent_update`: what kind of subagent (Explore, Plan, …).
 * @property {{ cancel?: object | null } | null} [capabilities] `subagent_update`: what the client may do to it.
 * @property {{ state: SubagentState, stopReason?: string | object | null } | null} [state] `subagent_update`.
 * @property {string} [messageId] `session_message` / `session_message_chunk`.
 * @property {string | null} [senderSessionId] `session_message` / `session_message_chunk`.
 * @property {string | null} [recipientSessionId] `session_message` / `session_message_chunk`.
 */

/**
 * What an ACP subagent session is doing: working, blocked on the user (a permission), done (its
 * `stopReason` says how), or not known.
 * @typedef {'running' | 'requires_action' | 'idle' | 'unknown'} SubagentState
 */

/**
 * A subagent of a chat, as the backend's `subagents` event lists them (`Subagent` in
 * `session/runtime/subagents.rs`), whatever told it: the chat's agent over ACP, or the records of a
 * CLI-run chat's agent. Runtime state of its chat; not a chat itself (spec:
 * `docs/specs/workspaces.md` §2.12).
 * @typedef {Object} Subagent
 * @property {string} id Its ACP session id.
 * @property {string | null} title
 * @property {string | null} description Its kind (Explore, Plan, …).
 * @property {SubagentState | null} state `null`: not reported.
 * @property {string | null} stopReason `idle`: `end_turn`, `cancelled`, `error`, …
 * @property {boolean} cancellable The agent lets the user stop it.
 * @property {string} announcedAt ISO time it was first seen.
 */

/**
 * ACP `PermissionOption`.
 * @typedef {{ optionId: string, name: string, kind: string }} AcpPermissionOption
 */

/**
 * A session event from the backend's channel; `seq` is monotonic per session. `turn-end` carries
 * ACP's `stopReason` (`end_turn`, `cancelled`, …); an `error` with `turn` ended the running turn.
 * `at` is the stamp the backend's `touch()` wrote (`lastActivityAt`), on `turn-end` and an `error` with `turn`; `activity`: the agent's output, at most one per second.
 * `held`: the turn's prompt waits for a sign-in; `prompt-returned`: such a prompt was dropped unsent.
 * `cli-exited`: the session's CLI (its Terminal view) ended.
 * @typedef {{ sessionId: string, seq: number } & (
 *   { kind: 'update', payload: AcpSessionUpdate }
 *   | { kind: 'snapshot', payload: { updates: AcpSessionUpdate[] } }
 *   | { kind: 'status', payload: { status: SessionStatus, message?: string | null } }
 *   | { kind: 'permission-request',
 *       payload: { requestId: string, toolCall: AcpSessionUpdate, options: AcpPermissionOption[], subagentId?: string } }
 *   | { kind: 'subagents', payload: { subagents: Subagent[] } }
 *   | { kind: 'turn-start', payload: Record<string, never> }
 *   | { kind: 'queued', payload: { holder: { id: string, title: string | null } } }
 *   | { kind: 'overlap', payload: { path: string, other: { id: string, title: string } } }
 *   | { kind: 'activity', payload: { at: string } }
 *   | { kind: 'turn-end', payload: { stopReason: string, at: string } }
 *   | { kind: 'error', payload: { message: string, turn?: false } | { message: string, turn: true, at: string } }
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
 * @property {string | null} [subagentId] The subagent asking; absent for the chat itself.
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
 * @property {SessionNotice} [under] The notice it covers (`overlap`'s, a refused send's), back when it goes.
 * @property {string} [offAgent] `error`: the user turned this agent off; Turn on starts the session again.
 * @property {SessionSignIn} [signIn] `sign-in`: the agent and the ways it offers.
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
 * A new chat with no message yet (`$draftSessions`): its project and its workspace (`main` or a
 * workspace's id).
 * @typedef {Object} DraftSession
 * @property {string} projectId
 * @property {string} workspaceId
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
 * The context window as ACP's last `usage_update` reported it (its cost isn't kept).
 * @typedef {Object} ContextUsage
 * @property {number} used Tokens.
 * @property {number} size Tokens.
 */

export {};
