import {
  agentsTrust,
  listSessions,
  sessionApplyLocally,
  sessionCheckOutBranch,
  sessionCreate,
  sessionHistory,
  sessionOpen,
  sessionOpenLog,
  sessionRemove,
  sessionRename,
  sessionResetTitle,
  sessionRespondPermission,
  sessionRestart,
  sessionResume,
  sessionSetConfigOption,
  sessionStop,
  workspaceSettings,
} from './ipc.js';
import { forgetSession, handleSessionEvent, restoreHistory, trackCreate } from './acp-adapter.js';
import { reportError } from './notices.js';
import { notify } from '../stores/notices.js';
import {
  composerOf,
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
  setListedSessions,
  showProject,
  startSession,
  upsertSession,
} from '../stores/sessions.js';
import { $sessionNotices, removePermissionRequest, setSessionNotice } from '../stores/session-runtime.js';
import { $workspacePath, setWorkspaceSettings } from '../stores/workspace.js';

/** How long a hidden session's agent may sit idle before it's stopped (showing it resumes it). */
const IDLE_STOP_MS = 10 * 60_000;

/**
 * Loads sessions from the backend into `$sessions` / `$activeSessionId` and opens each one's event
 * channel, keeps the active session in the opened project, creates a draft's backend session on its
 * first message, resumes a shown session's stopped agent and stops hidden idle ones, and runs the
 * session actions (permissions, stop, restart, log).
 */
export class SessionController {
  /** @type {Set<string>} Listed sessions whose recorded conversation was asked for. */
  #historyLoaded = new Set();
  /** Sequence of workspace.json reads; only the latest answer is kept. */
  #settingsLoad = 0;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} Hidden sessions whose agent stops once idle. */
  #idleStops = new Map();

  /** @returns {Promise<void>} */
  async init() {
    const sessions = await listSessions();
    setListedSessions(sessions);
    for (const session of sessions) {
      sessionOpen(session.id, handleSessionEvent).catch((err) => reportError(`Opening "${session.title}" failed`, err));
    }
    // A session's conversation comes back the first time it's shown, not all at launch. Showing a
    // session resumes its stopped agent; the one it replaces is stopped once idle for a while.
    /** @type {string | null} */
    let shown = null;
    $activeSessionId.subscribe((id) => {
      if (shown !== null) this.#stopWhenIdle(shown);
      shown = id;
      if (id === null) return;
      clearTimeout(this.#idleStops.get(id));
      this.#idleStops.delete(id);
      if (sessions.some((s) => s.id === id)) this.#loadHistory(id);
      this.#resume(id);
    });
    $workspacePath.subscribe((path) => {
      this.#loadSettings(path);
      if (path !== null) showProject(path);
    });
  }

  /**
   * Reads the project's workspace.json: the run target its new sessions start with.
   * @param {string | null} path
   */
  async #loadSettings(path) {
    const load = ++this.#settingsLoad;
    setWorkspaceSettings(null);
    if (path === null) return;
    try {
      const settings = await workspaceSettings(path);
      if (load === this.#settingsLoad) setWorkspaceSettings(settings);
    } catch (err) {
      reportError('Reading .brama/workspace.json failed', err);
    }
  }

  /**
   * Starts a stopped session's agent; one that can't start where it is (see `sessionResume`) keeps
   * its stopped banner, whose Resume says why.
   * @param {string} id
   */
  #resume(id) {
    if ($sessions.get().find((s) => s.id === id)?.status !== 'stopped') return;
    sessionResume(id).catch((err) => reportError('Starting the agent failed', err));
  }

  /**
   * Stops a hidden session's agent after `IDLE_STOP_MS`, or later if it's busy then.
   * @param {string} id
   */
  #stopWhenIdle(id) {
    clearTimeout(this.#idleStops.get(id));
    const timer = setTimeout(() => {
      this.#idleStops.delete(id);
      if ($activeSessionId.get() === id) return;
      const status = $sessions.get().find((s) => s.id === id)?.status;
      if (status === 'idle') this.stop(id);
      else if (status !== undefined && status !== 'stopped' && status !== 'error') this.#stopWhenIdle(id);
    }, IDLE_STOP_MS);
    this.#idleStops.set(id, timer);
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
   */
  select(id) {
    selectSession(id);
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
   * project, or a worktree one's base is gone), it's a draft again with the reason above its
   * composer. With no agent configured nothing starts, and the notice says how to add one.
   * @param {string} id
   * @param {string} title
   * @returns {boolean} Whether the message goes: `false` keeps it in the composer.
   */
  start(id, title) {
    const projectPath = $draftSessions.get()[id];
    if (projectPath === undefined) return true;
    // Only what was picked in the draft: the values it shows otherwise are another session's.
    const { agentId, chosen: config, runTarget } = composerOf(id);
    if (agentId === null) {
      setSessionNotice(id, { kind: 'info', message: 'Add an ACP agent to .brama/agents.json to start a session.' });
      return false;
    }
    const mode = runTarget.kind;
    const baseBranch = mode === 'worktree' ? runTarget.branch : null;
    // While it's a draft still: a listed session without a composer would get one from its record.
    startComposer(id);
    startSession(id, { title, agentId, config, mode });
    setSessionNotice(id, null);
    const request = { sessionId: id, projectPath, agentId, mode, title, config, baseBranch };
    const created = sessionCreate(request, handleSessionEvent).then(
      (session) => upsertSession(session),
      (err) => {
        revertToDraft(id);
        setSessionNotice(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
    trackCreate(id, created);
    return true;
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
   * Brings a worktree session's work (commits and uncommitted changes since it started) into the
   * project's checkout as unstaged changes; says what happened.
   * @param {string} id
   */
  async applyLocally(id) {
    const title = $sessions.get().find((s) => s.id === id)?.title ?? 'the session';
    try {
      const result = await sessionApplyLocally(id);
      if (result.outcome === 'conflicts') notify('warn', `Applied "${title}" with conflicts in ${result.conflicts.join(', ')}`);
      else if (result.outcome === 'empty') notify('info', `"${title}" has no changes to apply`);
      else notify('info', `Applied "${title}" to the project, unstaged`);
    } catch (err) {
      reportError('Applying the session failed', err);
    }
  }

  /**
   * Stops a worktree session's agent and checks its branch out in the project.
   * @param {string} id
   */
  async checkOutBranch(id) {
    const branch = $sessions.get().find((s) => s.id === id)?.branch ?? 'the branch';
    try {
      await sessionCheckOutBranch(id);
      notify('info', `Checked out ${branch}`);
    } catch (err) {
      reportError(`Checking out ${branch} failed`, err);
    }
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
   * Gives a session a new title; a blank or unchanged one is ignored.
   * @param {string} id
   * @param {string} title
   */
  async rename(id, title) {
    const session = $sessions.get().find((s) => s.id === id);
    const trimmed = title.trim();
    if (!session || trimmed === '' || trimmed === session.title) return;
    try {
      upsertSession(await sessionRename(id, trimmed));
    } catch (err) {
      reportError('Renaming the session failed', err);
    }
  }

  /**
   * Gives a renamed session back its agent's title, which the agent then keeps up to date.
   * @param {string} id
   */
  async resetTitle(id) {
    try {
      upsertSession(await sessionResetTitle(id));
    } catch (err) {
      reportError('Resetting the title failed', err);
    }
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
    clearTimeout(this.#idleStops.get(id));
    this.#idleStops.delete(id);
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

/** The app's one `SessionController`. */
export const sessionController = new SessionController();
