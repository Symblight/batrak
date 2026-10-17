import {
  agentsTrust,
  getActiveSession,
  listSessions,
  sessionCreate,
  sessionHistory,
  sessionOpen,
  sessionOpenLog,
  sessionRemove,
  sessionRespondPermission,
  sessionRestart,
  sessionSetConfigOption,
  sessionStop,
  setActiveSession,
} from './ipc.js';
import { forgetSession, handleSessionEvent, restoreHistory, trackCreate } from './acp-adapter.js';
import { reportError } from './notices.js';
import {
  composerOf,
  configOf,
  forgetComposer,
  revertConfigOption,
  setConfigOption,
  startComposer,
} from '../stores/composer.js';
import {
  $activeSessionId,
  $draftSessions,
  $sessions,
  newSession,
  projectOf,
  removeSession,
  revertToDraft,
  selectSession,
  showProject,
  startSession,
  upsertSession,
} from '../stores/sessions.js';
import { $sessionNotices, removePermissionRequest, setSessionNotice } from '../stores/session-runtime.js';
import { $workspacePath } from '../stores/workspace.js';

/**
 * Loads sessions from the backend into `$sessions` / `$activeSessionId` and opens each one's event
 * channel, keeps the active session in the opened project, creates a draft's backend session on its
 * first message, and runs the session actions (permissions, stop, restart, log).
 */
export class SessionController {
  /** @type {Set<string>} Listed sessions whose recorded conversation was asked for. */
  #historyLoaded = new Set();

  /** @returns {Promise<void>} */
  async init() {
    const sessions = await listSessions();
    $sessions.set(sessions);
    for (const session of sessions) {
      sessionOpen(session.id, handleSessionEvent).catch((err) => reportError(`Opening "${session.title}" failed`, err));
    }
    // A session's conversation comes back the first time it's shown, not all at launch.
    $activeSessionId.subscribe((id) => {
      if (id !== null && sessions.some((s) => s.id === id)) this.#loadHistory(id);
    });
    const active = await getActiveSession();
    if (active !== null && projectOf(active) !== null) selectSession(active);
    $workspacePath.subscribe((path) => {
      if (path !== null) showProject(path);
    });
  }

  /**
   * Shows a session's recorded conversation in the chat, once per launch.
   * @param {string} id
   */
  async #loadHistory(id) {
    if (this.#historyLoaded.has(id)) return;
    this.#historyLoaded.add(id);
    try {
      restoreHistory(id, await sessionHistory(id));
    } catch (err) {
      reportError('Loading the conversation failed', err);
    }
  }

  /**
   * @param {string} id A listed session's or a draft's.
   * @returns {Promise<void>}
   */
  async select(id) {
    selectSession(id);
    if ($sessions.get().some((s) => s.id === id)) await setActiveSession(id);
  }

  /**
   * Shows an empty draft session in the project; the project itself is activated by the caller.
   * @param {string} projectId
   */
  create(projectId) {
    newSession(projectId);
  }

  /**
   * A draft's first message: it's listed at once, and the backend creates it (workspace, agent)
   * meanwhile; the send waits for that. Refused (e.g. a local session already runs in the
   * project), it's a draft again with the reason above its composer.
   * @param {string} id
   * @param {string} title
   */
  start(id, title) {
    const projectPath = $draftSessions.get()[id];
    if (projectPath === undefined) return;
    const { agentId, configOptions, runTarget } = composerOf(id);
    const model = configOf(configOptions, 'model')?.currentValue ?? null;
    const mode = runTarget.kind;
    startSession(id, { title, agentId, model, mode });
    startComposer(id);
    setSessionNotice(id, null);
    const created = sessionCreate({ sessionId: id, projectPath, agentId, mode, title, model }, handleSessionEvent).then(
      (session) => upsertSession(session),
      (err) => {
        revertToDraft(id);
        setSessionNotice(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
    trackCreate(id, created);
    if ($activeSessionId.get() === id) setActiveSession(id).catch(() => {});
  }

  /**
   * Sets the agent's model, thought level or mode for a session. Shown at once; a running agent gets
   * it now (and its answer replaces the options), otherwise it gets it when it starts.
   * @param {string} id A session's or a draft's.
   * @param {string} configId
   * @param {string} value
   */
  setConfigOption(id, configId, value) {
    const previous = composerOf(id).configOptions.find((o) => o.id === configId)?.currentValue;
    setConfigOption(id, configId, value);
    const status = $sessions.get().find((s) => s.id === id)?.status;
    if (status !== 'idle' && status !== 'working' && status !== 'waiting') return;
    sessionSetConfigOption(id, configId, value).catch((err) => {
      if (previous !== undefined) revertConfigOption(id, configId, previous);
      reportError('The agent refused the change', err);
    });
  }

  /**
   * Answers the agent's permission request.
   * @param {string} id
   * @param {string} requestId
   * @param {string | null} optionId `null` cancels it.
   */
  respondPermission(id, requestId, optionId) {
    removePermissionRequest(id, requestId);
    sessionRespondPermission(id, requestId, optionId).catch((err) => reportError('Answering the agent failed', err));
  }

  /**
   * Stops the agent and its whole process tree; the next message starts it again.
   * @param {string} id
   */
  stop(id) {
    sessionStop(id).catch((err) => reportError('Stopping the agent failed', err));
  }

  /**
   * Starts the agent again (after an error, or to resume a stopped session with its history).
   * @param {string} id
   */
  restart(id) {
    setSessionNotice(id, { kind: 'progress', message: 'Starting agent…' });
    sessionRestart(id).catch((err) => reportError('Restarting the agent failed', err));
  }

  /**
   * Removes a session for good: its agent stops, its conversation and log are deleted, and the chat
   * shows another session of the project. The project's files stay as they are.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    try {
      await sessionRemove(id);
    } catch (err) {
      reportError('Removing the session failed', err);
      return;
    }
    forgetSession(id);
    forgetComposer(id);
    this.#historyLoaded.delete(id);
    removeSession(id);
  }

  /**
   * Trusts what the project's agents.json runs for the session's agent, as its notice showed it,
   * and starts the agent.
   * @param {string} id
   */
  async trustAndStart(id) {
    const launch = $sessionNotices.get()[id]?.launch;
    const projectPath = projectOf(id);
    if (!launch || projectPath === null) return;
    try {
      await agentsTrust(projectPath, launch);
    } catch (err) {
      reportError('Trusting the agent failed', err);
      return;
    }
    this.restart(id);
  }

  /** @param {string} id */
  openLog(id) {
    sessionOpenLog(id).catch((err) => reportError('Opening the agent log failed', err));
  }

  /** @param {string} id */
  dismissNotice(id) {
    setSessionNotice(id, null);
  }
}

export const sessionController = new SessionController();
