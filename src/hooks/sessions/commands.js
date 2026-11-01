import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('../projects/types.js').OpenedRoot} OpenedRoot */
/** @typedef {import('../git/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('./types.js').ApplyResult} ApplyResult */
/** @typedef {import('./types.js').SessionEnvelope} SessionEnvelope */
/** @typedef {import('./types.js').PromptInput} PromptInput */
/** @typedef {import('./types.js').SyncReport} SyncReport */
/** @typedef {import('./types.js').SessionsSynced} SessionsSynced */
/** @typedef {import('../composer/types.js').RunTargetKind} RunTargetKind */
/** @typedef {import('../projects/types.js').WorkspaceSettings} WorkspaceSettings */

/** The Rust commands of sessions, their folders and the project's workspace settings. */

/** @returns {Promise<Session[]>} The sessions as last stored or synced. */
export function listSessions() {
  return ipc.invoke('list_sessions');
}

/**
 * Asks a project's agents (`agentIds`, else all) for its sessions; every window then hears them
 * (`onSessionsSynced`). Joins a sync of the project already running.
 * @param {string} projectPath
 * @param {string[] | null} [agentIds]
 * @returns {Promise<SyncReport>}
 */
export function sessionsSync(projectPath, agentIds = null) {
  return ipc.invoke('sessions_sync', { projectPath, agentIds });
}

/**
 * A project's sessions after a sync, in any window.
 * @param {(synced: SessionsSynced) => void} callback
 * @returns {Promise<() => void>} Stops listening.
 */
export function onSessionsSynced(callback) {
  return ipc.listen('sessions://synced', callback);
}

/**
 * A draft's first message: creates the session (under the draft's id) and starts its agent in the
 * background. Rejects when a worktree one has no repository or base to start from.
 * @param {Object} session
 * @param {string} session.sessionId
 * @param {string} session.projectPath
 * @param {string} session.agentId
 * @param {RunTargetKind} session.mode
 * @param {string} session.title
 * @param {Record<string, string>} session.config The agent's config options picked in the draft, by id.
 * @param {string | null} session.baseBranch `worktree`: the branch to start from; `null` for HEAD.
 * @param {(event: SessionEnvelope) => void} onEvent The session's events in this window.
 * @returns {Promise<Session>}
 */
export function sessionCreate({ sessionId, projectPath, agentId, mode, title, config, baseBranch }, onEvent) {
  return ipc.invoke('session_create', {
    sessionId,
    projectPath,
    agentId,
    mode,
    title,
    config,
    baseBranch,
    channel: channelOf(onEvent),
  });
}

/**
 * Sends a listed session's events to this window from now on, starting with its status.
 * @param {string} sessionId
 * @param {(event: SessionEnvelope) => void} onEvent
 * @returns {Promise<Session>}
 */
export function sessionOpen(sessionId, onEvent) {
  return ipc.invoke('session_open', { sessionId, channel: channelOf(onEvent) });
}

/**
 * @param {(event: SessionEnvelope) => void} onEvent
 * @returns {import('@tauri-apps/api/core').Channel<SessionEnvelope>}
 */
function channelOf(onEvent) {
  return ipc.channel(onEvent);
}

/**
 * Starts a turn; resolves once it's accepted (the agent starts first if it isn't running). Its
 * updates and `turn-end` arrive as session events.
 * @param {string} sessionId
 * @param {PromptInput[]} prompt
 * @returns {Promise<void>}
 */
export function sessionSendPrompt(sessionId, prompt) {
  return ipc.invoke('session_send_prompt', { sessionId, prompt });
}

/**
 * Cancels the running turn; pending permission requests are answered `cancelled`.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionCancel(sessionId) {
  return ipc.invoke('session_cancel', { sessionId });
}

/**
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string | null} optionId `null` cancels the request.
 * @returns {Promise<void>}
 */
export function sessionRespondPermission(sessionId, requestId, optionId) {
  return ipc.invoke('session_respond_permission', { sessionId, requestId, optionId });
}

/**
 * Stops the session's agent (its whole process tree).
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionStop(sessionId) {
  return ipc.invoke('session_stop', { sessionId });
}

/**
 * Sets the title a session is listed by (trimmed; an empty one is refused).
 * @param {string} sessionId
 * @param {string} title
 * @returns {Promise<Session>} The session as it is then.
 */
export function sessionRename(sessionId, title) {
  return ipc.invoke('session_rename', { sessionId, title });
}

/**
 * Gives a renamed session back the title its agent gave it.
 * @param {string} sessionId
 * @returns {Promise<Session>} The session as it is then.
 */
export function sessionResetTitle(sessionId) {
  return ipc.invoke('session_reset_title', { sessionId });
}

/**
 * Removes a session for good: stops its agent and deletes its conversation and log. The project's
 * files stay as they are.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionRemove(sessionId) {
  return ipc.invoke('session_remove', { sessionId });
}

/**
 * Stops and starts the agent again, continuing its ACP session where the agent supports it.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionRestart(sessionId) {
  return ipc.invoke('session_restart', { sessionId });
}

/**
 * A draft whose CLI starts it: what `session_create` would get.
 * @typedef {Object} CliDraft
 * @property {string} projectPath
 * @property {string} agentId
 * @property {import('../composer/types.js').RunTargetKind} mode
 * @property {string} title
 * @property {Record<string, string>} [config]
 * @property {string | null} [baseBranch]
 * @property {string} [prompt] Its first message, which the CLI starts with.
 */

/**
 * Runs a session's agent CLI in a terminal (its Terminal view), continuing it by its ACP id; refused
 * while its ACP agent runs, or while another window's CLI holds it. With `draft`, the CLI starts a new
 * session under `sessionId` (a UUID).
 * @param {string} sessionId
 * @param {number} cols
 * @param {number} rows
 * @param {CliDraft} [draft]
 * @returns {Promise<{ terminalId: string }>}
 */
export function sessionOpenCli(sessionId, cols, rows, draft) {
  return ipc.invoke('session_open_cli', draft ? { sessionId, cols, rows, draft } : { sessionId, cols, rows });
}

/**
 * Closes a session's CLI; resolves once its process is gone.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionCloseCli(sessionId) {
  return ipc.invoke('session_close_cli', { sessionId });
}

/**
 * @param {string} sessionId
 * @returns {Promise<boolean>} Its CLI is working: a tool runs in it, or it reported activity just now.
 */
export function sessionCliBusy(sessionId) {
  return ipc.invoke('session_cli_busy', { sessionId });
}

/**
 * Starts a stopped session's agent, continuing its ACP session where the agent supports it.
 * @param {string} sessionId
 * @returns {Promise<boolean>} `false` when it stays stopped: the project has its worktree's
 *   branch checked out.
 */
export function sessionResume(sessionId) {
  return ipc.invoke('session_resume', { sessionId });
}

/**
 * Sets the agent's model, thought level or mode; the options as they are then arrive as a
 * `config-options` session event. Rejects when the agent isn't running or refuses the value.
 * @param {string} sessionId
 * @param {string} configId
 * @param {string} value
 * @returns {Promise<void>}
 */
export function sessionSetConfigOption(sessionId, configId, value) {
  return ipc.invoke('session_set_config_option', { sessionId, configId, value });
}

/**
 * Opens the agent's stderr log in the OS's viewer.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionOpenLog(sessionId) {
  return ipc.invoke('session_open_log', { sessionId });
}

/**
 * The project's `.brama/workspace.json` settings; missing or invalid ones are the defaults.
 * @param {string} projectPath
 * @returns {Promise<WorkspaceSettings>}
 */
export function workspaceSettings(projectPath) {
  return ipc.invoke('workspace_settings', { projectPath });
}

/**
 * Scans a worktree session's folder for the Files tree and starts watching it.
 * @param {string} sessionId
 * @returns {Promise<OpenedRoot>}
 */
export function openSessionRoot(sessionId) {
  return ipc.invoke('open_session_root', { sessionId });
}

/**
 * A worktree session's changed files since it started (its commits and uncommitted work).
 * @param {string} sessionId
 * @returns {Promise<GitFileStatus[]>} Paths relative to the session's folder.
 */
export function sessionChanges(sessionId) {
  return ipc.invoke('session_changes', { sessionId });
}

/**
 * Applies a worktree session's work since it started to the project's checkout, unstaged. Rejects
 * while its agent is mid-turn.
 * @param {string} sessionId
 * @returns {Promise<ApplyResult>}
 */
export function sessionApplyLocally(sessionId) {
  return ipc.invoke('session_apply_locally', { sessionId });
}

/**
 * Stops a worktree session's agent and checks its branch out in the project's checkout. Rejects
 * while its agent is mid-turn or the worktree has uncommitted changes.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionCheckOutBranch(sessionId) {
  return ipc.invoke('session_check_out_branch', { sessionId });
}

/**
 * A worktree session's file at the commit it started from: its diff's baseline.
 * @param {string} sessionId
 * @param {string} path Relative to the session's folder.
 * @returns {Promise<string | null>} `null` when it's new there, binary or too large.
 */
export function sessionFileAtBase(sessionId, path) {
  return ipc.invoke('session_file_at_base', { sessionId, path });
}

/**
 * Saves a file attached in the composer into `folder`'s attachments (`.brama/attachments/`, which
 * git ignores), where the agent reads it by its path.
 * @param {string} folder A folder of an open project or a session's.
 * @param {File} file
 * @returns {Promise<string>} Its absolute path.
 */
export async function saveAttachment(folder, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return ipc.invoke('save_attachment', bytes, { headers: { folder: encodeURIComponent(folder), name: encodeURIComponent(file.name) } });
}
