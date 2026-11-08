import { app } from '../app/app.js';
import { listSessions, sessionCliBusy, onSessionsSynced, sessionCreate, sessionOpen, sessionOpenCli, sessionRemove, sessionResume } from './commands.js';
import { actions } from './actions.js';
import { CLI_SIZE, openCli, restartCli, cliBusy, toChat } from './cli.js';
import { cancelIdleStop, stopWhenIdle } from './idle.js';
import { forgetSession, handleSessionEvent, trackCreate, turnTaken } from './adapter.js';
import { agents } from '../agents/agents.js';
import { projects } from '../projects/projects.js';
import { terminals } from '../terminals/terminals.js';
import { composerOf, forgetComposer, reopenComposer, setRunTarget, startComposer } from '../../stores/composer/composer.js';
import { composer } from '../composer/composer.js';
import { workspaces } from '../workspaces/workspaces.js';
import { trackSeen } from './seen.js';
import { poll, sync, syncAgentOf } from './sync.js';
import { inTurn, isActiveElsewhere } from './rules.js';
import { $agentList } from '../../stores/agents/agents.js';
import { forgetContextUsage } from '../../stores/context-usage/context-usage.js';
import { forgetRead, recordBaselines } from '../../stores/session-read/session-read.js';
import { endSync, syncOf } from '../../stores/session-sync/session-sync.js';
import { offerAgentsMdAgain } from '../../stores/agents-md/agents-md.js';
import { showColumn } from '../../stores/layout/layout.js';
import {
  $activeSessionId,
  $draftSessions,
  $sessions,
  moveSession,
  newSession,
  removeSession,
  revertToDraft,
  selectSession,
  setListedSessions,
  setProjectSessions,
  showWorkspace,
  startSession,
  upsertSession,
} from '../../stores/sessions/sessions.js';
import { $activePermission, setSessionNotice } from '../../stores/session-runtime/session-runtime.js';
import { $activeView, forgetSessionView, setSessionView, viewOfSession } from '../../stores/session-views/session-views.js';
import { forgetPendingInput } from '../../stores/chat/chat.js';
import { $cliStarting, $sessionTerminals, $terminals, addSessionTerminal, focusTerminal, forgetTerminal, sessionTerminalOf, setCliStarting } from '../../stores/terminals/terminals.js';
import { $projectPath } from '../../stores/project/project.js';
import { $activeWorkspaceId, $shownFolder, MAIN, setActiveWorkspace } from '../../stores/workspaces/workspaces.js';
import { computed } from 'nanostores';

/** While a window shows a project, its agents that list are asked again this often: a session another app runs starts and stops showing so. */
const POLL_MS = 20_000;

/** @typedef {import('./types.js').Session} Session */

/**
 * A session's event; one asking to sign in (or done waiting) changes what the picker says of its agent.
 * @param {import('./types.js').SessionEnvelope} event
 */
function onSessionEvent(event) {
  handleSessionEvent(event);
  if (event.kind === 'sign-in') agents.refresh();
}

/** The shown project's workspace, with its folder; `null` while its record loads. */
const $shownWorkspace = computed([$projectPath, $activeWorkspaceId, $shownFolder], (projectPath, id, folder) =>
  projectPath === null || folder === null ? null : { projectPath, id, folder },
);

/**
 * Where a draft's chat is created (its footer's place, `composer.runTargetOf()`) and the workspace it's
 * listed in meanwhile (a New worktree chat: the draft's, until its own exists).
 * @param {string} id A draft's.
 */
export function placeOf(id) {
  const draft = $draftSessions.get()[id];
  if (draft === undefined) return null;
  // A picked New worktree holds even while `$workspacesEnabled` is false (a root switch, git loading):
  // the backend refuses one that can't be, and the draft comes back.
  const target = composer.runTargetOf(composerOf(id).runTarget, draft.workspaceId);
  const local = target.kind === 'local';
  return {
    projectPath: draft.projectId,
    target,
    workspaceId: local ? MAIN : draft.workspaceId,
  };
}

/** @typedef {NonNullable<ReturnType<typeof placeOf>>} Place */

/**
 * A draft's first message lists it where it goes; the window shows that workspace with it.
 * @param {string} id
 * @param {Place} place
 * @param {Pick<Session, 'title' | 'agentId' | 'config' | 'acpSessionId'>} fields
 */
function startDraft(id, place, fields) {
  unknownToBackend.add(id);
  startComposer(id);
  startSession(id, fields, place.workspaceId);
  setSessionNotice(id, null);
  if ($activeSessionId.get() === id) setActiveWorkspace(place.projectPath, place.workspaceId);
}

/**
 * The started chat's workspace for the backend: a New worktree's is created first
 * (`workspaces.create()`), and the chat moves into it, shown.
 * @param {string} id
 * @param {Place} place
 * @returns {Promise<string | null | undefined>} Its id, `null` for Main; `undefined`: the chat was
 *   removed meanwhile; its new workspace is deleted, and nothing more is created for it.
 */
async function workspaceFor(id, place) {
  const { target, projectPath } = place;
  if (target.kind === 'local') return null;
  if (target.kind === 'workspace') return place.workspaceId;
  const created = await workspaces.create(projectPath, target.base);
  if (!$sessions.get().some((s) => s.id === id)) {
    // Removing the chat meant "don't run this": its workspace, still empty, goes too.
    void workspaces.delete(created.id, false);
    return undefined;
  }
  moveSession(id, created);
  // A draft again (its chat refused), it's this workspace's.
  setRunTarget(id, { kind: 'workspace' });
  if ($activeSessionId.get() === id) setActiveWorkspace(projectPath, created.id);
  return created.id;
}

/**
 * A New worktree's workspace wasn't created: the chat is a draft again, and a snackbar says why.
 * @param {string} id
 * @param {unknown} err
 */
function workspaceFailed(id, err) {
  app.reportError('Creating the workspace failed', err);
  revertDraft(id);
}

/** @type {Set<string>} Started chats not yet asked of the backend (`session_create` / `session_open_cli`): removed, they're only unlisted. */
const unknownToBackend = new Set();

/** @type {Set<string>} Sessions whose event channel this window opened. */
const opened = new Set();
/** @type {string | null} The shown session once its agent's list is current: its view is acted on from then. */
let ready = null;
/** @type {Promise<boolean>} The last reconcile; the next waits for it. */
let reconciling = Promise.resolve(false);
/** @type {Set<string>} Sessions whose busy CLI was kept although they're to be Chat; until shown again or switched by hand. */
const keptBusy = new Set();

/** @returns {Promise<void>} */
async function init() {
  trackSeen();
  onSessionsSynced(({ projectPath, sessions, report }) => {
    endSync(projectPath, report);
    // Before the sessions: the baseline is what a session first seen in this list is judged against.
    try {
      recordBaselines(report);
    } catch (err) {
      app.reportError('Recording session baselines failed', err);
    }
    setProjectSessions(projectPath, sessions);
    openAll(sessions);
  }).catch((err) => app.reportError('Listening for session syncs failed', err));
  const sessions = await listSessions();
  setListedSessions(sessions);
  openAll(sessions);
  // A session's conversation is its agent's replay when it's shown: showing a session syncs its
  // agent's list, then resumes its stopped agent unless another app may be running it (asked first,
  // or Batrak would load a session a terminal is writing); the one it replaces is stopped once idle.
  /** @type {string | null} */
  let shown = null;
  $activeSessionId.subscribe((id) => {
    if (shown !== null) stopWhenIdle(shown);
    if (shown !== null) keptBusy.delete(shown);
    shown = id;
    ready = null;
    if (id === null) return;
    cancelIdleStop(id);
    show(id);
  });
  $projectPath.subscribe((path) => {
    if (path === null) return;
    // Before showing: the shown session's one-agent sync then waits for this one.
    sync(path);
  });
  // The shown workspace's chat: kept if it's one already, else its last, newest or a new draft.
  let shownKey = '';
  $shownWorkspace.subscribe((shown) => {
    const key = shown === null ? '' : `${shown.projectPath}\n${shown.id}\n${shown.folder}`;
    if (key === shownKey) return;
    shownKey = key;
    if (shown !== null) showWorkspace(shown.projectPath, shown.id, shown.folder);
  });
  // Agents added, turned on, trusted or signed in: those that neither listed nor said they can't
  // last time are asked now.
  $agentList.subscribe(({ agents: listed }) => {
    const path = $projectPath.get();
    const report = path === null ? null : syncOf(path).report;
    if (path === null || report === null || syncOf(path).running) return;
    const settled = new Set(
      report.agents.filter((a) => a.outcome === 'listed' || a.outcome === 'unsupported').map((a) => a.agentId),
    );
    const due = listed.filter((a) => a.enabled && !settled.has(a.id)).map((a) => a.id);
    if (due.length > 0) sync(path, { force: true, agentIds: due });
  });
  // The shown session's view changed (the header, its agent's choice in the Agents tab, a first
  // message, its turn ended): its CLI starts or closes to match.
  for (const store of [$activeView, $activePermission, $sessions, $sessionTerminals]) {
    store.listen(() => {
      if (ready !== null && ready === $activeSessionId.get()) reconcile();
    });
  }
  setInterval(() => poll(), POLL_MS);
}

/**
 * A session shown (`$activeSessionId`): its agent's choice decides chat or terminal at once; once its
 * agent's list is current, its CLI starts or its stopped agent is resumed (`#resume`).
 * @param {string} id
 */
async function show(id) {
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
    await syncAgentOf(id);
  } finally {
    if (early && $activeSessionId.get() !== id) setCliStarting(id, false);
  }
  if ($activeSessionId.get() !== id) return;
  ready = id;
  if (early) setCliStarting(id, false);
  const acted = await reconcile();
  if (!acted && $activeSessionId.get() === id && viewOfSession(id) === 'chat') resume(id);
}

/**
 * Makes the active session shown as its view asks: starts its CLI (not a draft's, which shows its
 * composer until its first message) or closes it and resumes its agent. Unless `force` (the user asked, and was asked about
 * the work it stops), a turn running or waiting for an answer is left to end first, and a busy CLI
 * is kept until the session is switched again.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} The session has, or now had, a CLI to act on.
 */
function reconcile({ force = false } = {}) {
  const run = reconciling.then(() => reconcileNow(force));
  reconciling = run.catch(() => false);
  return run;
}

/**
 * @param {boolean} force
 * @returns {Promise<boolean>}
 */
async function reconcileNow(force) {
  const id = $activeSessionId.get();
  if (id === null) return false;
  const terminalId = sessionTerminalOf(id);
  if (viewOfSession(id) === 'terminal') {
    keptBusy.delete(id);
    if (terminalId !== null || $cliStarting.get().includes(id)) return true;
    const session = $sessions.get().find((s) => s.id === id);
    // A draft shows its composer: its first message starts the CLI (`startInTerminal`).
    if (!session) return false;
    if (!force && (turnTaken(id) || inTurn(session.status, $activePermission.get() !== null))) return false;
    await openCli(id);
    return true;
  }
  if (terminalId === null) return false;
  if (!force && $terminals.get()[terminalId]?.status === 'running') {
    if (keptBusy.has(id)) return true;
    if (await sessionCliBusy(id).catch(() => false)) {
      keptBusy.add(id);
      return true;
    }
  }
  await toChat(id);
  return true;
}

/**
 * Shows a session in its agent's CLI: a running turn is stopped first (the column asked), its ACP
 * agent stopped, and the CLI continues it in a terminal.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function continueInTerminal(id) {
  setSessionView(id, 'terminal');
  if ($activeSessionId.get() === id) await reconcile({ force: true });
  else await openCli(id);
  const terminal = sessionTerminalOf(id);
  if (terminal !== null) focusTerminal(terminal);
}

/**
 * Shows a session as Chat again: its CLI is closed (the column asked), and its agent resumes it,
 * replaying the turns the CLI ran.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function continueInChat(id) {
  setSessionView(id, 'chat');
  if ($activeSessionId.get() === id) await reconcile({ force: true });
  else await toChat(id);
}

/**
 * Whether a draft's first message starts its agent's CLI rather than the chat: its agent's
 * sessions open in the terminal, and its CLI can start one.
 * @param {string} id
 * @returns {boolean}
 */
function startsInTerminal(id) {
  return id in $draftSessions.get() && !$sessions.get().some((s) => s.id === id) && viewOfSession(id) === 'terminal';
}

/**
 * A draft's first message, for its agent's CLI: listed at once, and its CLI starts the agent's
 * session under the draft's id, with the draft's picks and the message as its first prompt.
 * Refused, it's a draft again, with the reason above its composer (a New worktree's refused
 * workspace: in its snackbar only).
 * @param {string} id
 * @param {string} title
 * @param {string} prompt
 * @returns {Promise<'started' | 'refused' | 'reported'>} Its CLI started; or not, and nothing was
 *   said yet (`refused`) or why was said (`reported`; also the chat removed meanwhile).
 */
async function startInTerminal(id, title, prompt) {
  const place = placeOf(id);
  const { agentId, chosen: config } = composerOf(id);
  if (place === null || agentId === null) return 'refused';
  const { projectPath } = place;
  startDraft(id, place, { title, agentId, config });
  setCliStarting(id, true);
  const label = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? 'Agent';
  try {
    let workspaceId;
    try {
      workspaceId = await workspaceFor(id, place);
    } catch (err) {
      workspaceFailed(id, err);
      return 'reported';
    }
    if (workspaceId === undefined) return 'reported';
    unknownToBackend.delete(id);
    const { terminalId } = await sessionOpenCli(id, CLI_SIZE.cols, CLI_SIZE.rows, { projectPath, agentId, title, config, workspaceId, prompt });
    addSessionTerminal(terminalId, id, projectPath, label);
    const session = $sessions.get().find((s) => s.id === id);
    if (session) openAll([session]);
  } catch (err) {
    revertDraft(id);
    setSessionNotice(id, { kind: 'error', message: `Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}` });
    return 'reported';
  } finally {
    setCliStarting(id, false);
  }
  return 'started';
}

/**
 * A session whose start was refused is a draft again, with no read mark, its agent no longer fixed.
 * @param {string} id
 */
function revertDraft(id) {
  unknownToBackend.delete(id);
  revertToDraft(id);
  forgetRead(id);
  if (id in $draftSessions.get()) reopenComposer(id);
}

/** @param {Session[]} sessions Opens the event channel of each one this window hasn't yet. */
function openAll(sessions) {
  for (const session of sessions) {
    if (opened.has(session.id)) continue;
    opened.add(session.id);
    sessionOpen(session.id, onSessionEvent).catch((err) => {
      opened.delete(session.id);
      app.reportError(`Opening "${session.title}" failed`, err);
    });
  }
}

/**
 * Starts a stopped session's agent; one that can't start where it is (see `sessionResume`) keeps
 * its stopped banner, whose Resume says why.
 * @param {string} id
 */
function resume(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (session?.status !== 'stopped') return;
  if (isActiveElsewhere(session, Date.now())) {
    // Resume (the banner's) starts it anyway.
    const message = 'Another app may be running this session now: two apps writing one session can lose messages. Resume to open it here.';
    setSessionNotice(id, { kind: 'stopped', message });
    return;
  }
  sessionResume(id).catch((err) => app.reportError('Starting the agent failed', err));
}

/**
 * @param {string} id A listed session's or a draft's.
 */
function select(id) {
  selectSession(id);
}

/**
 * Open in → Terminal: a terminal in the session's folder, in its project's terminal panel, shown with the session.
 * @param {string} id
 */
async function openInTerminal(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  try {
    await projects.activate(session.projectId);
  } catch (err) {
    app.reportError('Opening project failed', err);
    return;
  }
  select(session.id);
  terminals.openInSession(session);
}

/**
 * Shows an empty draft session in a workspace of the project; the project itself is activated by the caller.
 * @param {string} projectId
 * @param {string} [workspaceId] `main` (default) for Main.
 * @param {import('../composer/types.js').RunTarget} [target] Where it runs, picked in advance (New workspace: a New worktree);
 *   none: its workspace's default, whatever the reused draft had picked.
 */
function create(projectId, workspaceId, target) {
  const id = newSession(projectId, workspaceId);
  setRunTarget(id, target ?? null);
  offerAgentsMdAgain();
  // A new chat is for typing in: an expanded editor gives the agent column back.
  showColumn('agent');
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
function start(id, title) {
  const place = placeOf(id);
  if (place === null) return true;
  // Only what was picked in the draft: the values it shows otherwise are another session's.
  const { agentId, chosen: config } = composerOf(id);
  if (agentId === null) {
    setSessionNotice(id, { kind: 'info', message: 'Add an ACP agent to .bt/agents.json to start a session.' });
    return false;
  }
  // While it's a draft still: a listed session without a composer would get one from its record.
  startDraft(id, place, { title, agentId, config, acpSessionId: null });
  const { projectPath } = place;
  const create = async () => {
    let workspaceId;
    try {
      workspaceId = await workspaceFor(id, place);
    } catch (err) {
      workspaceFailed(id, err);
      throw err;
    }
    // Removed meanwhile: its send fails, nothing is prompted.
    if (workspaceId === undefined) throw new Error('The session was removed');
    unknownToBackend.delete(id);
    try {
      upsertSession(await sessionCreate({ sessionId: id, projectPath, agentId, title, config, workspaceId }, onSessionEvent));
    } catch (err) {
      revertDraft(id);
      setSessionNotice(id, { kind: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  trackCreate(id, create());
  return true;
}

/**
 * Removes a session for good: its agent stops, it's deleted in its agent (or hidden where the agent
 * can't delete), its log is deleted, and the chat shows another session of the project. The
 * project's files stay as they are.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function remove(id) {
  try {
    // One the backend doesn't know yet is only unlisted (its New worktree's workspace is still being created).
    if (!unknownToBackend.delete(id)) await sessionRemove(id);
  } catch (err) {
    app.reportError('Removing the session failed', err);
    return;
  }
  cancelIdleStop(id);
  // The backend closed a running CLI; one that exited by itself left its terminal.
  const terminalId = sessionTerminalOf(id);
  if (terminalId !== null) {
    if ($terminals.get()[terminalId]?.status === 'exited') await terminals.close([terminalId]).catch(() => {});
    forgetTerminal(terminalId);
  }
  forgetSessionView(id);
  forgetSession(id);
  forgetComposer(id);
  forgetContextUsage(id);
  forgetPendingInput(id);
  opened.delete(id);
  removeSession(id);
  // After it is unlisted: while it's shown and listed, dropping its mark would have it marked seen again.
  forgetRead(id);
}

/**
 * Loads the stored sessions from the backend into `$sessions` / `$activeSessionId` and opens each
 * one's event channel, syncs a project's sessions with its agents (launch, a project shown, a
 * session clicked, its agents changed, Resync), keeps the active session in the opened project,
 * creates a draft's backend session on its first message, resumes a shown session's stopped agent
 * (its history is the agent's replay) and stops hidden idle ones, and runs the session actions
 * (permissions, stop, restart, log).
 */
export const controller = Object.freeze({
  init,
  show,
  reconcile,
  continueInTerminal,
  continueInChat,
  startsInTerminal,
  startInTerminal,
  restartCli,
  cliBusy,
  sync,
  select,
  openInTerminal,
  create,
  start,
  ...actions,
  remove,
});
