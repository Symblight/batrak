/** @typedef {import('./types.js').ConfirmOptions} ConfirmOptions */
/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').SessionIndicator} SessionIndicator */
/** @typedef {import('./types.js').SessionStatus} SessionStatus */
/** @typedef {import('./types.js').SessionSync} SessionSync */
/** @typedef {import('./types.js').SessionView} SessionView */
/** @typedef {import('./types.js').AgentTerminal} AgentTerminal */

/** Statuses in which a session holds (or is getting) an agent process. */
export const RUNNING = new Set(['preparing', 'starting', 'idle', 'working', 'queued', 'waiting']);

/**
 * Whether a session is in a turn: working, queued, waiting for an answer, or asking a permission.
 * Switching its view then waits for the turn's end, unless the user agreed to stop it.
 * @param {SessionStatus | null} status
 * @param {boolean} [permissionPending]
 */
export function inTurn(status, permissionPending = false) {
  return permissionPending || status === 'working' || status === 'queued' || status === 'waiting';
}

/** What a session's status icon says, also its tooltip. */
export const INDICATOR_LABELS = /** @type {const} */ ({
  permission: 'Waiting for your permission',
  error: 'Last turn failed',
  running: 'Agent is working',
  queued: 'Waiting for the project',
  elsewhere: 'Active in another app',
  terminal: 'In terminal',
  'terminal-working': 'Working in terminal',
  unread: 'New output',
});

/**
 * The one status a session shows, the most urgent first; `null` when there's nothing to say.
 * @param {SessionStatus} status
 * @param {boolean} permissionPending A permission request of it waits for the user.
 * @param {boolean} [unread] It has output not seen yet.
 * @param {boolean} [activeElsewhere] Another app may be running it (`isActiveElsewhere()`).
 * @param {boolean} [inTerminal] Its agent's CLI runs it in Brama's terminal: activity elsewhere is that CLI's.
 * @returns {SessionIndicator | null}
 */
export function sessionIndicator(status, permissionPending, unread = false, activeElsewhere = false, inTerminal = false) {
  if (permissionPending || status === 'waiting') return 'permission';
  if (status === 'error') return 'error';
  if (status === 'preparing' || status === 'starting' || status === 'working') return 'running';
  if (status === 'queued') return 'queued';
  if (inTerminal) return activeElsewhere ? 'terminal-working' : 'terminal';
  if (activeElsewhere) return 'elsewhere';
  return unread ? 'unread' : null;
}

/**
 * Whether another app (a terminal) may be running a session now: it doesn't run here, and its agent
 * saw activity in it that wasn't Brama's, recently enough (`Session.activeElsewhereUntil`).
 * @param {Session} session
 * @param {number} now ms.
 */
export function isActiveElsewhere(session, now) {
  const until = session.activeElsewhereUntil;
  return !RUNNING.has(session.status) && typeof until === 'string' && Date.parse(until) > now;
}

/**
 * Whether a session can be shown in its agent's CLI.
 * @param {AgentTerminal | null | undefined} terminal Its agent's (`AgentSummary.terminal`).
 * @param {boolean} draft No message yet: the CLI must start it under an id Brama chooses.
 */
export function canUseTerminal(terminal, draft) {
  return terminal != null && (draft ? terminal.new : terminal.resume);
}

/**
 * How a session is shown: its own view, else its agent's; always `chat` when its agent's CLI can't
 * show it.
 * @param {SessionView | undefined} own The session's own (`$sessionViews`).
 * @param {SessionView} preferred Its agent's (`$agentViews`).
 * @param {AgentTerminal | null | undefined} terminal Its agent's.
 * @param {boolean} draft
 * @returns {SessionView}
 */
export function viewOf(own, preferred, terminal, draft) {
  return canUseTerminal(terminal, draft) ? (own ?? preferred) : 'chat';
}

/**
 * The session's own view to keep for a choice: none when it's its agent's, so a later change of
 * the agent's applies to it again.
 * @param {SessionView} view
 * @param {SessionView} preferred
 * @returns {SessionView | undefined}
 */
export function ownView(view, preferred) {
  return view === preferred ? undefined : view;
}

/**
 * Why the header's Chat / Terminal button is disabled for a session; `''` when it isn't.
 * @param {AgentTerminal | null | undefined} terminal
 * @param {boolean} draft
 * @param {string} agentName
 */
export function viewDisabledReason(terminal, draft, agentName) {
  if (terminal == null) return `${agentName} has no terminal mode`;
  if (!canUseTerminal(terminal, draft)) return draft ? 'Send a first message, then continue in the terminal' : `${agentName} can't continue this session in its terminal`;
  return '';
}

/**
 * A project's sessions as its list shows them: pinned first, each part most recently active first.
 * @param {readonly Session[]} sessions
 * @param {readonly string[]} pinned Session ids.
 * @returns {Session[]}
 */
export function orderSessions(sessions, pinned) {
  const rank = (/** @type {Session} */ s) => (pinned.includes(s.id) ? 0 : 1);
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** How many of a project's sessions its list shows at first, and adds with each Show more. */
export const SESSIONS_PAGE = 5;

/**
 * The part of a project's ordered sessions its list shows: the first `limit`, or down to the selected
 * session when it's further down.
 * @param {readonly Session[]} sessions In list order.
 * @param {number} limit
 * @param {string | null} activeId
 * @returns {{ shown: Session[], hidden: number }}
 */
export function visibleSessions(sessions, limit, activeId) {
  const active = sessions.findIndex((s) => s.id === activeId);
  const count = Math.min(sessions.length, Math.max(limit, active + 1));
  return { shown: sessions.slice(0, count), hidden: sessions.length - count };
}

/**
 * The projects whose session lists are loading: all of them until the stored list arrives, then each
 * one in its first sync.
 * @param {readonly string[]} projectIds
 * @param {boolean} loaded The stored list arrived (`$sessionsLoaded`).
 * @param {Readonly<Record<string, SessionSync>>} syncs By project id (`$sessionSync`).
 * @returns {string[]}
 */
export function loadingProjects(projectIds, loaded, syncs) {
  if (!loaded) return [...projectIds];
  return projectIds.filter((id) => syncs[id]?.running === true && syncs[id]?.report === null);
}

/**
 * What removing a session asks first; the project's files stay either way.
 * @param {Session} session
 * @returns {ConfirmOptions}
 */
export function removeSessionConfirm(session) {
  return {
    headline: 'Remove session?',
    message: `"${session.title}" will be deleted from ${session.agentName ?? 'its agent'}, for every app that uses it${RUNNING.has(session.status) ? ', and its agent stopped' : ''}.`,
    detail:
      session.mode === 'worktree'
        ? `Its worktree is deleted; uncommitted work is first committed onto ${session.branch}, which is kept if it has commits.`
        : 'Files the agent changed in the project stay as they are.',
    confirmLabel: 'Remove',
    destructive: true,
  };
}

/** @type {Record<import('./types.js').SyncOutcome, (count: number | null, error: string | null) => string>} */
const OUTCOMES = {
  listed: (count) => (count === 1 ? '1 session' : `${count ?? 0} sessions`),
  unsupported: () => "can't list sessions",
  off: () => 'turned off',
  untrusted: () => 'not trusted yet',
  signIn: () => 'needs sign-in',
  failed: (_, error) => `failed: ${error ?? 'unknown error'}`,
};

/**
 * What a project's sync indicator says: when it last synced (its tooltip), how each agent did, and
 * whether an agent needs the user (failed, sign-in, trust).
 * @param {SessionSync} sync
 * @param {number} now ms.
 * @returns {{ label: string, lines: string[], warn: boolean }}
 */
export function syncSummary({ running, report }, now) {
  if (running) return { label: 'Syncing sessions…', lines: report ? linesOf(report) : [], warn: false };
  if (!report) return { label: 'Not synced yet', lines: [], warn: false };
  const minutes = Math.floor((now - Date.parse(report.endedAt)) / 60_000);
  const label = minutes < 1 ? 'Synced just now' : minutes < 60 ? `Synced ${minutes} min ago` : `Synced ${Math.floor(minutes / 60)} h ago`;
  const warn = report.agents.some((a) => a.outcome === 'failed' || a.outcome === 'signIn' || a.outcome === 'untrusted');
  return { label, lines: linesOf(report), warn };
}

/** @param {import('./types.js').SyncReport} report */
function linesOf(report) {
  return report.agents.map((a) => `${a.agentName} · ${OUTCOMES[a.outcome](a.count, a.error)}`);
}
