
/** Statuses in which a session holds (or is getting) an agent process. */
export const RUNNING = new Set(['preparing', 'starting', 'idle', 'working', 'queued', 'waiting']);
export { canUseTerminal, ownView, viewDisabledReason, viewOf } from '../../stores/session-views/session-views.js';

/** @typedef {import('../app/types.js').ConfirmOptions} ConfirmOptions */
/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').SessionIndicator} SessionIndicator */
/** @typedef {import('./types.js').SessionRead} SessionRead */
/** @typedef {import('./types.js').SessionStatus} SessionStatus */
/** @typedef {import('./types.js').SessionSync} SessionSync */

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
});

/**
 * The one status a session shows, the most urgent first; `null` when there's nothing to say.
 * @param {SessionStatus} status
 * @param {boolean} permissionPending A permission request of it waits for the user.
 * @param {boolean} [activeElsewhere] Another app may be running it (`isActiveElsewhere()`).
 * @param {boolean} [inTerminal] Its agent's CLI runs it in Brama's terminal: activity elsewhere is that CLI's.
 * @returns {SessionIndicator | null}
 */
export function sessionIndicator(status, permissionPending, activeElsewhere = false, inTerminal = false) {
  if (permissionPending || status === 'waiting') return 'permission';
  if (status === 'error') return 'error';
  if (status === 'preparing' || status === 'starting' || status === 'working') return 'running';
  if (status === 'queued') return 'queued';
  if (inTerminal) return activeElsewhere ? 'terminal-working' : 'terminal';
  if (activeElsewhere) return 'elsewhere';
  return null;
}

/** Activity this close after a session was seen still reads as seen: agents write their own files a little after Brama's stamp. The backend's `OWN_ACTIVITY_SLACK_MS`. */
export const READ_SLACK_MS = 5000;

/** The backend stamps a session's output at most this often (`activity` events). */
export const OUTPUT_STAMP_MS = 1000;

/** Statuses of a session whose agent has sent no output yet: its `lastActivityAt` is the user's prompt. */
const BEFORE_OUTPUT = new Set(['preparing', 'starting', 'queued']);

/**
 * Whether a session has activity the user hasn't seen. Marked unread by hand (`seen: null`), or
 * activity more than `READ_SLACK_MS` after `seen`; with no mark, after the project's `baseline` for
 * its agent (no baseline: read). A session still preparing, starting or queued has sent no output, so
 * its stamp (the user's prompt) never counts through the baseline, only against a mark.
 * @param {Session} session
 * @param {SessionRead | undefined} read Its read mark, if any.
 * @param {string | undefined} baseline When its agent first listed its project's sessions (ISO).
 */
export function isUnread(session, read, baseline) {
  const activity = Date.parse(session.lastActivityAt);
  if (read !== undefined) return read.seen === null || activity - Date.parse(read.seen) > READ_SLACK_MS;
  if (baseline === undefined || BEFORE_OUTPUT.has(session.status)) return false;
  return activity - Date.parse(baseline) > READ_SLACK_MS;
}

/**
 * A project's unread sessions, and how many of them are past the first `shown` (Show more's hidden ones).
 * @param {readonly Session[]} sessions The project's, in list order.
 * @param {readonly string[]} unread Unread session ids (`$unreadSessions`).
 * @param {number} [shown] How many lead the list; default: all.
 * @returns {{ count: number, hidden: number }}
 */
export function unreadIn(sessions, unread, shown = sessions.length) {
  const ids = new Set(unread);
  const flags = sessions.map((s) => ids.has(s.id));
  return { count: flags.filter(Boolean).length, hidden: flags.slice(shown).filter(Boolean).length };
}

/**
 * A session's age in words, for a row's accessible name ("13 minutes ago"); `<acp-datetime compact>`
 * shows the same age as "13m". Empty for a time that doesn't parse.
 * @param {string} at ISO time.
 * @param {number} now ms.
 */
export function ageLabel(at, now) {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((now - time) / 60_000);
  if (!(minutes >= 1)) return 'just now';
  /** @param {number} n @param {string} unit */
  const ago = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return ago(minutes, 'minute');
  if (minutes < 60 * 24) return ago(Math.floor(minutes / 60), 'hour');
  return ago(Math.floor(minutes / (60 * 24)), 'day');
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
      session.workspaceId
        ? 'Its workspace, and the files the agent changed there, stay as they are.'
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

/**
 * The `<chx-chat>` conversation that shows a chat's subagent.
 * @param {string} sessionId
 * @param {string} subagentId Its ACP session id.
 */
export function subagentConversationId(sessionId, subagentId) {
  return `${sessionId}/${subagentId}`;
}

/** @typedef {import('./types.js').Subagent} Subagent */
/**
 * The status a subagent's row shows.
 * @typedef {'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'unknown'} SubagentIndicator
 */

/** @type {Readonly<Record<SubagentIndicator, string>>} */
export const SUBAGENT_INDICATOR_LABELS = Object.freeze({
  running: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  unknown: 'Status unknown',
});

/**
 * @param {Subagent} subagent
 * @returns {SubagentIndicator}
 */
export function subagentIndicator({ state, stopReason }) {
  if (state === 'running') return 'running';
  if (state === 'requires_action') return 'waiting';
  if (state !== 'idle') return 'unknown';
  if (stopReason === 'cancelled') return 'stopped';
  return stopReason === null || stopReason === 'end_turn' ? 'done' : 'failed';
}

/**
 * A subagent's name in a row: its kind and title (`Explore · Find usages`).
 * @param {Subagent} subagent
 */
export function subagentLabel({ description, title }) {
  return [description, title ?? 'Subagent'].filter(Boolean).join(' · ');
}

/**
 * The tool call id of a subagent's card in its chat's reply: its part's key. What makes it a card
 * is its `data.subagentId`, not this id.
 * @param {string} subagentId
 */
export function subagentCardId(subagentId) {
  return `subagent-${subagentId}`;
}
