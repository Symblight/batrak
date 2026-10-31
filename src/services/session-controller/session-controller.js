import {
  listSessions,
  sessionApplyLocally,
  sessionCheckOutBranch,
  sessionCliBusy,
  sessionCloseCli,
  onSessionsSynced,
  sessionCreate,
  sessionOpen,
  sessionOpenCli,
  sessionOpenLog,
  sessionRemove,
  sessionRename,
  sessionResetTitle,
  sessionRespondPermission,
  sessionRestart,
  sessionResume,
  sessionSetConfigOption,
  sessionStop,
  sessionsSync,
  terminalClose,
  workspaceSettings,
} from '../ipc/ipc.js';
import { forgetHistory, forgetSession, handleSessionEvent, trackCreate } from '../acp-adapter/acp-adapter.js';
import { agentConfig } from '../agent-config/agent-config.js';
import { log } from '../logger/logger.js';
import { reportError } from '../notices/notices.js';
import { notify } from '../../stores/notices/notices.js';
import {
  composerOf,
  forgetComposer,
  revertConfigOption,
  setConfigOption,
  startComposer,
} from '../../stores/composer/composer.js';
import { sessionRootController } from '../session-root-controller/session-root-controller.js';
import { RUNNING, inTurn, isActiveElsewhere } from '../../models/sessions/sessions.js';
import { $agentList } from '../../stores/agents/agents.js';
import { forgetContextUsage } from '../../stores/context-usage/context-usage.js';
import { endSync, startSync, syncOf } from '../../stores/session-sync/session-sync.js';
import { removeProjectExpandedFolders } from '../../stores/file-tree/file-tree.js';
import {
  $activeSessionId,
  $draftSessions,
  $sessions,
  newSession,
  removeSession,
  revertToDraft,
  selectSession,
  setListedSessions,
  setProjectSessions,
  showProject,
  startSession,
  upsertSession,
} from '../../stores/sessions/sessions.js';
import { $activePermission, dismissSessionNotice, removePermissionRequest, setSessionNotice } from '../../stores/session-runtime/session-runtime.js';
import { $activeView, forgetSessionView, setSessionView, viewOfSession } from '../../stores/session-views/session-views.js';
import { forgetPendingInput, resetHistory } from '../../stores/chat/chat.js';
import {
  $cliStarting,
  $sessionTerminals,
  $terminals,
  addSessionTerminal,
  forgetTerminal,
  sessionTerminalOf,
  setCliStarting,
  terminalFailed,
} from '../../stores/terminals/terminals.js';
import { $workspacePath, setWorkspaceSettings } from '../../stores/workspace/workspace.js';

/** How long a hidden session's agent may sit idle before it's stopped (showing it resumes it). */
const IDLE_STOP_MS = 10 * 60_000;
/** A project shown again is synced with its agents when its last sync is older than this. */
const SYNC_STALE_MS = 5 * 60_000;
/** Clicking a session syncs its agent's sessions, at most this often per agent and project. */
const SELECT_SYNC_MS = 30_000;
/** While a window shows a project, its agents that list are asked again this often: a session another app runs starts and stops showing so. */
const POLL_MS = 20_000;
/** A CLI starts at this size; its view sends the real one once attached. */
const CLI_SIZE = { cols: 80, rows: 24 };

/**
 * Loads the stored sessions from the backend into `$sessions` / `$activeSessionId` and opens each
 * one's event channel, syncs a project's sessions with its agents (launch, a project shown, a
 * session clicked, its agents changed, Resync), keeps the active session in the opened project,
 * creates a draft's backend session on its first message, resumes a shown session's stopped agent
 * (its history is the agent's replay) and stops hidden idle ones, and runs the session actions
 * (permissions, stop, restart, log).
 */
/** @typedef {import('../../models/types/types.js').Session} Session */

/**
 * A session's event; one asking to sign in (or done waiting) changes what the picker says of its agent.
 * @param {import('../../models/types/types.js').SessionEnvelope} event
 */
function onSessionEvent(event) {
  handleSessionEvent(event);
  if (event.kind === 'sign-in') agentConfig.refresh();
}

export class SessionController {
  /** @type {Set<string>} Sessions whose event channel this window opened. */
  #opened = new Set();
  /** @type {Map<string, number>} When each project's last sync started, ms. */
  #syncedAt = new Map();
  /** @type {Map<string, number>} When a click last synced an agent of a project (`project\0agent`), ms. */
  #selectSyncedAt = new Map();
  /** @type {Map<string, Promise<void>>} Each project's syncs running now; settles once all have. */
  #syncing = new Map();
  /** Sequence of workspace.json reads; only the latest answer is kept. */
  #settingsLoad = 0;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} Hidden sessions whose agent stops once idle. */
  #idleStops = new Map();
  /** @type {Map<string, Promise<void>>} Sessions whose CLI is starting, so a second ask doesn't start another. */
  #cliOpening = new Map();
  /** @type {string | null} The shown session once its agent's list is current: its view is acted on from then. */
  #ready = null;
  /** @type {Promise<boolean>} The last reconcile; the next waits for it. */
  #reconciling = Promise.resolve(false);
  /** @type {Set<string>} Sessions whose busy CLI was kept although they're to be Chat; until shown again or switched by hand. */
  #keptBusy = new Set();

  /** @returns {Promise<void>} */
  async init() {
    onSessionsSynced(({ projectPath, sessions, report }) => {
      endSync(projectPath, report);
      setProjectSessions(projectPath, sessions);
      this.#openAll(sessions);
    }).catch((err) => reportError('Listening for session syncs failed', err));
    const sessions = await listSessions();
    setListedSessions(sessions);
    this.#openAll(sessions);
    // A session's conversation is its agent's replay when it's shown: showing a session syncs its
    // agent's list, then resumes its stopped agent unless another app may be running it (asked first,
    // or Brama would load a session a terminal is writing); the one it replaces is stopped once idle.
    /** @type {string | null} */
    let shown = null;
    $activeSessionId.subscribe((id) => {
      if (shown !== null) this.#stopWhenIdle(shown);
      if (shown !== null) this.#keptBusy.delete(shown);
      shown = id;
      this.#ready = null;
      if (id === null) return;
      clearTimeout(this.#idleStops.get(id));
      this.#idleStops.delete(id);
      this.show(id);
    });
    $workspacePath.subscribe((path) => {
      this.#loadSettings(path);
      if (path === null) return;
      // Before showing: the shown session's one-agent sync then waits for this one.
      this.sync(path);
      showProject(path);
    });
    // Agents added, turned on, trusted or signed in: those that neither listed nor said they can't
    // last time are asked now.
    $agentList.subscribe(({ agents }) => {
      const path = $workspacePath.get();
      const report = path === null ? null : syncOf(path).report;
      if (path === null || report === null || syncOf(path).running) return;
      const settled = new Set(
        report.agents.filter((a) => a.outcome === 'listed' || a.outcome === 'unsupported').map((a) => a.agentId),
      );
      const due = agents.filter((a) => a.enabled && !settled.has(a.id)).map((a) => a.id);
      if (due.length > 0) this.sync(path, { force: true, agentIds: due });
    });
    // The shown session's view changed (the header, its agent's choice in the Agents tab, a first
    // message, its turn ended): its CLI starts or closes to match.
    for (const store of [$activeView, $activePermission, $sessions, $sessionTerminals]) {
      store.listen(() => {
        if (this.#ready !== null && this.#ready === $activeSessionId.get()) this.reconcile();
      });
    }
    setInterval(() => this.#poll(), POLL_MS);
  }

  /**
   * Asks the shown project's agents that list for its sessions again, quietly (no spinner), while
   * the window is visible.
   */
  #poll() {
    const path = $workspacePath.get();
    if (path === null || document.visibilityState !== 'visible') return;
    const { report, running } = syncOf(path);
    if (report === null || running || this.#syncing.has(path)) return;
    const listing = report.agents
      .filter((a) => a.outcome === 'listed' || a.outcome === 'failed')
      .map((a) => a.agentId);
    if (listing.length > 0) this.sync(path, { agentIds: listing, quiet: true });
  }

  /**
   * A session shown (`$activeSessionId`): its agent's choice decides chat or terminal at once; once its
   * agent's list is current, its CLI starts or its stopped agent is resumed (`#resume`).
   * @param {string} id
   */
  async show(id) {
    // Its agent's choice decides at once: a terminal session never shows its chat while its agent's
    // list is asked for.
    const session = $sessions.get().find((s) => s.id === id);
    const early =
      session !== undefined &&
      viewOfSession(id) === 'terminal' &&
      !inTurn(session.status) &&
      sessionTerminalOf(id) === null &&
      !$cliStarting.get().includes(id);
    if (early) setCliStarting(id, true);
    try {
      await this.#syncAgentOf(id);
    } finally {
      if (early && $activeSessionId.get() !== id) setCliStarting(id, false);
    }
    if ($activeSessionId.get() !== id) return;
    this.#ready = id;
    if (early) setCliStarting(id, false);
    const acted = await this.reconcile();
    if (!acted && $activeSessionId.get() === id && viewOfSession(id) === 'chat') this.#resume(id);
  }

  /**
   * Makes the active session shown as its view asks: starts its CLI (not a draft's, which shows its
   * composer until its first message) or closes it and resumes its agent. Unless `force` (the user asked, and was asked about
   * the work it stops), a turn running or waiting for an answer is left to end first, and a busy CLI
   * is kept until the session is switched again.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<boolean>} The session has, or now had, a CLI to act on.
   */
  reconcile({ force = false } = {}) {
    const run = this.#reconciling.then(() => this.#reconcileNow(force));
    this.#reconciling = run.catch(() => false);
    return run;
  }

  /**
   * @param {boolean} force
   * @returns {Promise<boolean>}
   */
  async #reconcileNow(force) {
    const id = $activeSessionId.get();
    if (id === null) return false;
    const terminalId = sessionTerminalOf(id);
    if (viewOfSession(id) === 'terminal') {
      this.#keptBusy.delete(id);
      if (terminalId !== null || $cliStarting.get().includes(id)) return true;
      const session = $sessions.get().find((s) => s.id === id);
      // A draft shows its composer: its first message starts the CLI (`startInTerminal`).
      if (!session) return false;
      if (!force && inTurn(session.status, $activePermission.get() !== null)) return false;
      await this.#openCli(id);
      return true;
    }
    if (terminalId === null) return false;
    if (!force && $terminals.get()[terminalId]?.status === 'running') {
      if (this.#keptBusy.has(id)) return true;
      if (await sessionCliBusy(id).catch(() => false)) {
        this.#keptBusy.add(id);
        return true;
      }
    }
    await this.#toChat(id);
    return true;
  }

  /**
   * Shows a session in its agent's CLI: a running turn is stopped first (the column asked), its ACP
   * agent stopped, and the CLI continues it in a terminal.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async continueInTerminal(id) {
    setSessionView(id, 'terminal');
    if ($activeSessionId.get() === id) await this.reconcile({ force: true });
    else await this.#openCli(id);
  }

  /**
   * Shows a session as Chat again: its CLI is closed (the column asked), and its agent resumes it,
   * replaying the turns the CLI ran.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async continueInChat(id) {
    setSessionView(id, 'chat');
    if ($activeSessionId.get() === id) await this.reconcile({ force: true });
    else await this.#toChat(id);
  }

  /**
   * Closes the session's CLI and resumes its agent, whose replay rebuilds the chat with the turns the
   * CLI ran.
   * @param {string} id
   */
  async #toChat(id) {
    await this.#cliOpening.get(id);
    await this.#closeCli(id);
    resetHistory(id);
    forgetHistory(id);
    // Not `#resume`: the activity another app showed was this CLI's.
    if ($sessions.get().find((s) => s.id === id)?.status === 'stopped')
      await sessionResume(id).catch((err) => reportError('Starting the agent failed', err));
  }

  /**
   * Whether a draft's first message starts its agent's CLI rather than the chat: its agent's
   * sessions open in the terminal, and its CLI can start one.
   * @param {string} id
   * @returns {boolean}
   */
  startsInTerminal(id) {
    return id in $draftSessions.get() && !$sessions.get().some((s) => s.id === id) && viewOfSession(id) === 'terminal';
  }

  /**
   * A draft's first message, for its agent's CLI: listed at once, and its CLI starts the agent's
   * session under the draft's id, with the draft's picks and the message as its first prompt.
   * Refused, it's a draft again, with the reason above its composer.
   * @param {string} id
   * @param {string} title
   * @param {string} prompt
   * @returns {Promise<boolean>} Its CLI started.
   */
  async startInTerminal(id, title, prompt) {
    const projectPath = $draftSessions.get()[id];
    const { agentId, chosen: config, runTarget } = composerOf(id);
    if (projectPath === undefined || agentId === null) return false;
    const mode = runTarget.kind;
    const baseBranch = mode === 'worktree' ? runTarget.branch : null;
    startComposer(id);
    startSession(id, { title, agentId, config, mode });
    setSessionNotice(id, null);
    setCliStarting(id, true);
    const label = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? 'Agent';
    try {
      const { terminalId } = await sessionOpenCli(id, CLI_SIZE.cols, CLI_SIZE.rows, { projectPath, agentId, mode, title, config, baseBranch, prompt });
      addSessionTerminal(terminalId, id, projectPath, label);
      const session = $sessions.get().find((s) => s.id === id);
      if (session) this.#openAll([session]);
    } catch (err) {
      revertToDraft(id);
      setSessionNotice(id, { kind: 'error', message: `Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    } finally {
      setCliStarting(id, false);
    }
    return true;
  }

  /**
   * Starts the CLI again after it exited or failed to start.
   * @param {string} id
   */
  async restartCli(id) {
    await this.#closeCli(id);
    await this.#openCli(id);
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} Closing its CLI would stop its work.
   */
  cliBusy(id) {
    return sessionTerminalOf(id) === null ? Promise.resolve(false) : sessionCliBusy(id).catch(() => false);
  }

  /**
   * Starts the session's CLI unless it runs; once however many ask meanwhile.
   * @param {string} id
   * @returns {Promise<void>}
   */
  #openCli(id) {
    let opening = this.#cliOpening.get(id);
    if (!opening) {
      opening = this.#startCli(id).finally(() => this.#cliOpening.delete(id));
      this.#cliOpening.set(id, opening);
    }
    return opening;
  }

  /** @param {string} id */
  async #startCli(id) {
    const session = $sessions.get().find((s) => s.id === id);
    const running = sessionTerminalOf(id);
    if (!session || (running !== null && $terminals.get()[running]?.status === 'running')) return;
    if (running !== null) forgetTerminal(running);
    clearTimeout(this.#idleStops.get(id));
    this.#idleStops.delete(id);
    const label = session.agentName ?? 'Agent';
    // From now on, so the chat doesn't show while its agent stops.
    setCliStarting(id, true);
    try {
      if (RUNNING.has(session.status)) {
        try {
          await sessionStop(id);
        } catch (err) {
          reportError('Stopping the agent failed', err);
          return;
        }
      }
      const { terminalId } = await sessionOpenCli(id, CLI_SIZE.cols, CLI_SIZE.rows);
      addSessionTerminal(terminalId, id, session.folder, label);
    } catch (err) {
      // Shown in its place, with Restart and Continue in chat; never attached (the backend has no such terminal).
      const failed = `cli:${id}`;
      addSessionTerminal(failed, id, session.folder, label);
      terminalFailed(failed, `Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCliStarting(id, false);
    }
  }

  /**
   * Closes the session's CLI, if it has one; resolves once it's gone.
   * @param {string} id
   */
  async #closeCli(id) {
    const terminalId = sessionTerminalOf(id);
    if (terminalId === null) return;
    const status = $terminals.get()[terminalId]?.status;
    if (status === 'running') await sessionCloseCli(id).catch((err) => reportError('Closing the terminal failed', err));
    // Exited by itself: the backend let the session go, but keeps its terminal's output.
    else if (status === 'exited') await terminalClose([terminalId]).catch(() => {});
    forgetTerminal(terminalId);
  }

  /** @param {Session[]} sessions Opens the event channel of each one this window hasn't yet. */
  #openAll(sessions) {
    for (const session of sessions) {
      if (this.#opened.has(session.id)) continue;
      this.#opened.add(session.id);
      sessionOpen(session.id, onSessionEvent).catch((err) => {
        this.#opened.delete(session.id);
        reportError(`Opening "${session.title}" failed`, err);
      });
    }
  }

  /**
   * Asks a project's agents for its sessions; they arrive through `sessions://synced`. Skipped while
   * the last sync is younger than `SYNC_STALE_MS`, unless `force` or `agentIds` are given. A `quiet`
   * one (a poll) shows no spinner and reports no failure.
   * @param {string} projectId
   * @param {{ force?: boolean, agentIds?: string[] | null, quiet?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async sync(projectId, { force = false, agentIds = null, quiet = false } = {}) {
    const last = this.#syncedAt.get(projectId);
    if (!force && agentIds === null && last !== undefined && Date.now() - last < SYNC_STALE_MS) return;
    if (agentIds === null) this.#syncedAt.set(projectId, Date.now());
    if (!quiet) startSync(projectId);
    const run = sessionsSync(projectId, agentIds).then(
      (report) => endSync(projectId, report),
      (err) => {
        if (quiet) {
          log('warn', `polling sessions failed: ${err}`);
          return;
        }
        endSync(projectId, null);
        reportError('Syncing sessions failed', err);
      },
    );
    // Another sync of the project may still run (a click's during the full one): wait for both.
    const before = this.#syncing.get(projectId);
    const all = before === undefined ? run : Promise.all([before, run]).then(() => {});
    this.#syncing.set(projectId, all);
    all.then(() => {
      if (this.#syncing.get(projectId) === all) this.#syncing.delete(projectId);
    });
    await run;
  }

  /**
   * A click on a session syncs its agent's sessions of the project (at most every `SELECT_SYNC_MS`);
   * resolves once that sync, or the project's sync running now, answered.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async #syncAgentOf(id) {
    const session = $sessions.get().find((s) => s.id === id);
    if (!session) return;
    const key = `${session.projectId}\0${session.agentId}`;
    const last = this.#selectSyncedAt.get(key);
    if (last !== undefined && Date.now() - last < SELECT_SYNC_MS) {
      await this.#syncing.get(session.projectId);
      return;
    }
    this.#selectSyncedAt.set(key, Date.now());
    await this.sync(session.projectId, { agentIds: [session.agentId] });
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
    const session = $sessions.get().find((s) => s.id === id);
    if (session?.status !== 'stopped') return;
    if (isActiveElsewhere(session, Date.now())) {
      // Resume (the banner's) starts it anyway.
      const message = 'Another app may be running this session now: two apps writing one session can lose messages. Resume to open it here.';
      setSessionNotice(id, { kind: 'stopped', message });
      return;
    }
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
   * meanwhile; the send waits for that. Refused (e.g. an untrusted launch, or a worktree one's
   * base is gone), it's a draft again with the reason above its
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
    const created = sessionCreate(request, onSessionEvent).then(
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
   * Removes a session for good: its agent stops, it's deleted in its agent (or hidden where the agent
   * can't delete), its log is deleted, and the chat shows another session of the project. The
   * project's files stay as they are.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    const worktree = $sessions.get().find((s) => s.id === id && s.mode === 'worktree')?.folder ?? null;
    // Nothing may watch the worktree while it's deleted (Windows refuses a watched folder).
    await sessionRootController.forget(id);
    try {
      await sessionRemove(id);
    } catch (err) {
      reportError('Removing the session failed', err);
      return;
    }
    clearTimeout(this.#idleStops.get(id));
    this.#idleStops.delete(id);
    // The backend closed a running CLI; one that exited by itself left its terminal.
    const terminalId = sessionTerminalOf(id);
    if (terminalId !== null) {
      if ($terminals.get()[terminalId]?.status === 'exited') await terminalClose([terminalId]).catch(() => {});
      forgetTerminal(terminalId);
    }
    forgetSessionView(id);
    forgetSession(id);
    forgetComposer(id);
    forgetContextUsage(id);
    forgetPendingInput(id);
    if (worktree !== null) removeProjectExpandedFolders(worktree);
    this.#opened.delete(id);
    removeSession(id);
  }

  /** @param {string} id */
  openLog(id) {
    sessionOpenLog(id).catch((err) => reportError('Opening the agent log failed', err));
  }

  /** @param {string} id */
  dismissNotice(id) {
    dismissSessionNotice(id);
  }
}

/** The app's one `SessionController`. */
export const sessionController = new SessionController();
