import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';

/** @typedef {import('../models/types.js').Session} Session */
/** @typedef {import('../models/types.js').WorkspaceEntry} WorkspaceEntry */
/** @typedef {import('../models/types.js').OpenedRoot} OpenedRoot */
/** @typedef {import('../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../models/types.js').QuickOpenResult} QuickOpenResult */
/** @typedef {import('../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../models/types.js').SearchEvent} SearchEvent */
/** @typedef {import('../models/types.js').GitStatusReply} GitStatusReply */
/** @typedef {import('../models/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../models/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../models/types.js').ApplyResult} ApplyResult */
/** @typedef {import('../models/types.js').GitCommitted} GitCommitted */
/** @typedef {import('../models/types.js').FontFamily} FontFamily */
/** @typedef {import('../models/types.js').LogLevel} LogLevel */
/** @typedef {import('../models/types.js').AboutInfo} AboutInfo */
/** @typedef {import('../models/types.js').NoticeLevel} NoticeLevel */
/** @typedef {import('../models/types.js').AgentList} AgentList */
/** @typedef {import('../models/types.js').SessionEnvelope} SessionEnvelope */
/** @typedef {import('../models/types.js').PromptInput} PromptInput */
/** @typedef {import('../models/types.js').TranscriptEntry} TranscriptEntry */
/** @typedef {import('../models/types.js').RunTargetKind} RunTargetKind */
/** @typedef {import('../models/types.js').WorkspaceSettings} WorkspaceSettings */

/** The only module that knows Rust command names. */

/** @returns {Promise<Session[]>} */
export function listSessions() {
  return invoke('list_sessions');
}

/**
 * A draft's first message: creates the session (under the draft's id) and starts its agent in the
 * background. Rejects when a local session already runs in the project, or a worktree one has no
 * repository or base to start from.
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
  return invoke('session_create', {
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
  return invoke('session_open', { sessionId, channel: channelOf(onEvent) });
}

/**
 * @param {(event: SessionEnvelope) => void} onEvent
 * @returns {Channel<SessionEnvelope>}
 */
function channelOf(onEvent) {
  /** @type {Channel<SessionEnvelope>} */
  const channel = new Channel();
  channel.onmessage = onEvent;
  return channel;
}

/**
 * Starts a turn; resolves once it's accepted (the agent starts first if it isn't running). Its
 * updates and `turn-end` arrive as session events.
 * @param {string} sessionId
 * @param {PromptInput[]} prompt
 * @returns {Promise<void>}
 */
export function sessionSendPrompt(sessionId, prompt) {
  return invoke('session_send_prompt', { sessionId, prompt });
}

/**
 * Cancels the running turn; pending permission requests are answered `cancelled`.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionCancel(sessionId) {
  return invoke('session_cancel', { sessionId });
}

/**
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string | null} optionId `null` cancels the request.
 * @returns {Promise<void>}
 */
export function sessionRespondPermission(sessionId, requestId, optionId) {
  return invoke('session_respond_permission', { sessionId, requestId, optionId });
}

/**
 * Stops the session's agent (its whole process tree).
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionStop(sessionId) {
  return invoke('session_stop', { sessionId });
}

/**
 * Sets the title a session is listed by (trimmed; an empty one is refused).
 * @param {string} sessionId
 * @param {string} title
 * @returns {Promise<Session>} The session as it is then.
 */
export function sessionRename(sessionId, title) {
  return invoke('session_rename', { sessionId, title });
}

/**
 * Gives a renamed session back the title its agent gave it.
 * @param {string} sessionId
 * @returns {Promise<Session>} The session as it is then.
 */
export function sessionResetTitle(sessionId) {
  return invoke('session_reset_title', { sessionId });
}

/**
 * Removes a session for good: stops its agent and deletes its conversation and log. The project's
 * files stay as they are.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionRemove(sessionId) {
  return invoke('session_remove', { sessionId });
}

/**
 * Stops and starts the agent again, continuing its ACP session where the agent supports it.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionRestart(sessionId) {
  return invoke('session_restart', { sessionId });
}

/**
 * Starts a stopped session's agent, continuing its ACP session where the agent supports it.
 * @param {string} sessionId
 * @returns {Promise<boolean>} `false` when it stays stopped: another local session runs in the
 *   project, or the project has its worktree's branch checked out.
 */
export function sessionResume(sessionId) {
  return invoke('session_resume', { sessionId });
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
  return invoke('session_set_config_option', { sessionId, configId, value });
}

/**
 * A session's recorded conversation, oldest first, to show it again after a reload.
 * @param {string} sessionId
 * @returns {Promise<TranscriptEntry[]>}
 */
export function sessionHistory(sessionId) {
  return invoke('session_history', { sessionId });
}

/**
 * Opens the agent's stderr log in the OS's viewer.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionOpenLog(sessionId) {
  return invoke('session_open_log', { sessionId });
}

/**
 * The project's `.brama/workspace.json` settings; missing or invalid ones are the defaults.
 * @param {string} projectPath
 * @returns {Promise<WorkspaceSettings>}
 */
export function workspaceSettings(projectPath) {
  return invoke('workspace_settings', { projectPath });
}

/**
 * Agents configured for a project: built-in, `<config dir>/brama/agents.json` and
 * `.brama/agents.json` merged.
 * @param {string | null} projectPath `null`: no project open.
 * @returns {Promise<AgentList>}
 */
export function agentsList(projectPath) {
  return invoke('agents_list', { projectPath });
}

/**
 * An agents.json changed: a project's (on disk or saved here), or the user's (`null`, every project).
 * @param {(projectPath: string | null) => void} callback
 * @returns {Promise<() => void>} Stops listening.
 */
export function onAgentsChanged(callback) {
  return listen('agents://changed', (event) =>
    callback(/** @type {{ projectPath: string | null }} */ (event.payload).projectPath),
  );
}

/**
 * The agents.json to edit, created with the defaults when missing: the project's
 * `.brama/agents.json`, or the user's without a project.
 * @param {string | null} projectPath
 * @returns {Promise<string>} Absolute path.
 */
export function agentsConfigFile(projectPath) {
  return invoke('agents_config_file', { projectPath });
}

/**
 * An agent's models, thought levels and modes before it has a session: it's started in a scratch
 * folder, asked, and stopped (no prompt is sent).
 * @param {string | null} projectPath Its config comes from this project's agents.json.
 * @param {string} agentId
 * @returns {Promise<import('../models/types.js').AcpConfigOption[]>}
 */
export function agentsProbeOptions(projectPath, agentId) {
  return invoke('agents_probe_options', { projectPath, agentId });
}

/**
 * The project's agents that run what its agents.json chose and wait for the user's trust.
 * @param {string} projectPath
 * @returns {Promise<import('../models/types.js').UntrustedAgent[]>}
 */
export function agentsUntrusted(projectPath) {
  return invoke('agents_untrusted', { projectPath });
}

/**
 * Trusts what a project's agents.json runs for some agents, as `agentsUntrusted()` listed them.
 * Refused, all of them, when the file changed since.
 * @param {string} projectPath
 * @param {import('../models/types.js').LaunchConfig[]} launches
 * @returns {Promise<void>}
 */
export function agentsTrust(projectPath, launches) {
  return invoke('agents_trust', { projectPath, launches });
}

/**
 * Saves a file from the editor; only agents.json files are accepted for now.
 * @param {string} path Absolute.
 * @param {string} content
 * @returns {Promise<void>}
 */
export function writeFile(path, content) {
  return invoke('write_file', { path, content });
}

/** @returns {Promise<AboutInfo>} Versions of the app and what it runs on. */
export function getAbout() {
  return invoke('about');
}

/** @returns {Promise<FontFamily[]>} Every installed font family. */
export function listFonts() {
  return invoke('list_fonts');
}

/**
 * Text content of a file (UTF-8).
 * @param {string} path Absolute.
 * @returns {Promise<string>}
 */
export function readFile(path) {
  return invoke('read_file', { path });
}

/**
 * Raw bytes of a file (an image), at most 64 MB.
 * @param {string} path Absolute.
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileBytes(path) {
  return invoke('read_file_bytes', { path });
}

/**
 * Scans a folder into a snapshot and starts watching it.
 * @param {string} path
 * @returns {Promise<OpenedRoot>}
 */
export function openWorkspace(path) {
  return invoke('open_workspace', { path });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function closeWorkspace(rootId) {
  return invoke('close_workspace', { rootId });
}

/**
 * Closes every root this window opened, e.g. ones a previous load of the page kept open.
 * @returns {Promise<void>}
 */
export function closeWindowWorkspaces() {
  return invoke('close_window_workspaces');
}

/**
 * Children of a directory from the snapshot.
 * @param {string} rootId
 * @param {string} path Relative; `''` for the root.
 * @returns {Promise<WorkspaceEntry[]>}
 */
export function listDir(rootId, path) {
  return invoke('list_dir', { rootId, path });
}

/**
 * Subscribes to snapshot changes made by the file watcher.
 * @param {(changes: WorkspaceChanges) => void} callback
 * @returns {Promise<() => void>} Unsubscribe.
 */
export function onWorkspaceChanged(callback) {
  return listen('workspace://changed', (event) => callback(/** @type {WorkspaceChanges} */ (event.payload)));
}

/**
 * Clicks on the app's own menu bar items (macOS), sent to the focused window.
 * @param {(id: 'about' | 'settings') => void} callback
 * @returns {Promise<() => void>} Stops listening.
 */
export function onMenuAction(callback) {
  return listen('menu://action', (event) => callback(/** @type {'about' | 'settings'} */ (event.payload)));
}

/**
 * The backend's own warnings and errors (panics included), sent to every window as they are logged.
 * @param {(notice: { level: NoticeLevel, message: string }) => void} callback
 * @returns {Promise<() => void>} Stops listening.
 */
export function onBackendNotice(callback) {
  return listen('app://notice', (event) =>
    callback(/** @type {{ level: NoticeLevel, message: string }} */ (event.payload)),
  );
}

/**
 * Fuzzy file search. A newer call cancels a running one (`cancelled: true`).
 * @param {string} rootId
 * @param {string} query
 * @param {boolean} [dirs] Search folders too.
 * @returns {Promise<QuickOpenResult>}
 */
export function quickOpen(rootId, query, dirs = false) {
  return invoke('quick_open', { rootId, query, dirs });
}

/**
 * @param {string} rootId
 * @param {string} path Relative.
 * @returns {Promise<void>}
 */
export function noteFileOpened(rootId, path) {
  return invoke('note_file_opened', { rootId, path });
}

/**
 * Starts a content search; results stream into `onEvent` until a `done` or `error` event.
 * A new search on the same root cancels the previous one.
 * @param {string} rootId
 * @param {SearchOptions} options
 * @param {(event: SearchEvent) => void} onEvent
 * @returns {Promise<void>} Resolves once the search has started.
 */
export function findInFiles(rootId, options, onEvent) {
  /** @type {Channel<SearchEvent>} */
  const channel = new Channel();
  channel.onmessage = onEvent;
  return invoke('find_in_files', { rootId, options, channel });
}

/**
 * @param {string} rootId
 * @returns {Promise<void>}
 */
export function cancelSearch(rootId) {
  return invoke('cancel_search', { rootId });
}

/**
 * Branch and upstream of the root's repository; cheap, no file scan.
 * @param {string} rootId
 * @returns {Promise<GitRepoState | null>} `null` when the root isn't in a repository.
 */
export function gitHead(rootId) {
  return invoke('git_head', { rootId });
}

/**
 * Branch and changed files of the root's repository; the working tree is scanned again only when
 * something changed since the backend's last scan.
 * @param {string} rootId
 * @param {number | null} since Version of the status the caller has; an unchanged one isn't sent again.
 * @param {boolean} [force] Scan even when nothing seems changed (the Refresh button).
 * @returns {Promise<GitStatusReply>}
 */
export function gitStatus(rootId, since, force = false) {
  return invoke('git_status', { rootId, since, force });
}

/**
 * A worktree session's changed files since it started (its commits and uncommitted work).
 * @param {string} sessionId
 * @returns {Promise<GitFileStatus[]>} Paths relative to the session's folder.
 */
export function sessionChanges(sessionId) {
  return invoke('session_changes', { sessionId });
}

/**
 * Applies a worktree session's work since it started to the project's checkout, unstaged. Rejects
 * while its agent is mid-turn.
 * @param {string} sessionId
 * @returns {Promise<ApplyResult>}
 */
export function sessionApplyLocally(sessionId) {
  return invoke('session_apply_locally', { sessionId });
}

/**
 * Stops a worktree session's agent and checks its branch out in the project's checkout. Rejects
 * while its agent is mid-turn or the worktree has uncommitted changes.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export function sessionCheckOutBranch(sessionId) {
  return invoke('session_check_out_branch', { sessionId });
}

/**
 * A worktree session's file at the commit it started from: its diff's baseline.
 * @param {string} sessionId
 * @param {string} path Relative to the session's folder.
 * @returns {Promise<string | null>} `null` when it's new there, binary or too large.
 */
export function sessionFileAtBase(sessionId, path) {
  return invoke('session_file_at_base', { sessionId, path });
}

/**
 * Local branches a worktree session can start from, most recently committed first (the sessions'
 * own `brama/…` left out).
 * @param {string} rootId
 * @returns {Promise<string[]>}
 */
export function gitBranches(rootId) {
  return invoke('git_branches', { rootId });
}

/**
 * Message of the last commit, which Amend starts from.
 * @param {string} rootId
 * @returns {Promise<string | null>} `null` before the first commit.
 */
export function gitLastCommitMessage(rootId) {
  return invoke('git_last_commit_message', { rootId });
}

/**
 * Commits files as they are in the working tree, whatever is staged; the user's hooks run.
 * @param {string} rootId
 * @param {string[]} paths Relative; both sides of a rename. Empty with `amend` rewords the last commit.
 * @param {string} message
 * @param {boolean} amend Replace the last commit.
 * @returns {Promise<GitCommitted>}
 */
export function gitCommit(rootId, paths, message, amend) {
  return invoke('git_commit', { rootId, paths, message, amend });
}

/**
 * A file's text at HEAD, the editor's diff baseline.
 * @param {string} rootId
 * @param {string} path Relative.
 * @returns {Promise<string | null>} `null` when not committed, binary, too large or not in a repository.
 */
export function gitFileAtHead(rootId, path) {
  return invoke('git_file_at_head', { rootId, path });
}

/**
 * Opens a web or mail link in the default app.
 * @param {string} url `http(s):` or `mailto:`; anything else is refused.
 * @returns {Promise<void>}
 */
export function openUrl(url) {
  return invoke('open_url', { url });
}

/**
 * Shows a folder in the OS file manager; rejects anything that isn't a folder.
 * @param {string} path Absolute.
 * @returns {Promise<void>}
 */
export function revealPath(path) {
  return invoke('reveal_path', { path });
}

/**
 * Appends a line to the app log, target `frontend`.
 * @param {LogLevel} level
 * @param {string} message
 * @returns {Promise<void>}
 */
export function writeLog(level, message) {
  return invoke('write_log', { level, message });
}

/** @returns {Promise<string>} The user's home folder. */
export function getHomeDir() {
  return homeDir();
}

/**
 * Native folder picker.
 * @returns {Promise<string | null>} Selected path, or null if cancelled.
 */
export async function pickFolder() {
  const result = await open({ directory: true, multiple: false });
  return typeof result === 'string' ? result : null;
}
