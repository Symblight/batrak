import { computed } from 'nanostores';
import { isRecord, persistentMapStore, storedItem } from '../persistent/persistent.js';
import { $sessions } from '../sessions/sessions.js';
import { isUnread } from '../../hooks/sessions/rules.js';

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../hooks/sessions/types.js').SessionRead} SessionRead */
/** @typedef {import('../../hooks/sessions/types.js').SyncReport} SyncReport */

const READ_PREFIX = 'brama:sessions:read:';
const BASELINE_PREFIX = 'brama:sessions:baseline:';
/** A session seen this recently needs no new mark: each write is a `storage` event in every other window. */
const SEEN_FRESH_MS = 1000;

/** @param {unknown} raw */
function isTime(raw) {
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw));
}

/**
 * @param {unknown} raw
 * @returns {SessionRead | null} `null` when it can't be read.
 */
export function parseSessionRead(raw) {
  if (!isRecord(raw) || !('seen' in raw)) return null;
  return raw.seen === null ? { seen: null } : isTime(raw.seen) ? { seen: /** @type {string} */ (raw.seen) } : null;
}

/** @param {unknown} raw */
function parseBaseline(raw) {
  return isTime(raw) ? /** @type {string} */ (raw) : null;
}

/**
 * When the user last saw each session, by session id; `seen: null` is a session marked unread by hand.
 * Shared by every window, kept across reloads and restarts. Marks are dropped only by `forgetRead()`.
 */
export const $sessionReads = persistentMapStore(READ_PREFIX, parseSessionRead, { listen: true });

/**
 * When a project's sessions of an agent were first listed (`baselineKey()` → ISO time): a session
 * never seen is unread only if it was active after that. Written once, shared by every window.
 */
export const $readBaselines = persistentMapStore(BASELINE_PREFIX, parseBaseline, { listen: true });

/**
 * @param {string} agentId
 * @param {string} projectId
 */
export function baselineKey(agentId, projectId) {
  return `${agentId}\n${projectId}`;
}

/**
 * A baseline in storage, valid or not to this window's store yet.
 * @param {string} key
 */
function storedBaseline(key) {
  const raw = storedItem(key);
  if (raw === null) return null;
  try {
    return parseBaseline(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Writes the baseline of each agent the report says `listed`, unless one exists: that of another window
 * too, which is looked up in storage itself since its event may not have arrived.
 * @param {SyncReport} report
 */
export function recordBaselines(report) {
  for (const agent of report.agents) {
    if (agent.outcome !== 'listed') continue;
    const key = baselineKey(agent.agentId, report.projectPath);
    if ($readBaselines.get()[key] !== undefined || storedBaseline(BASELINE_PREFIX + key) !== null) continue;
    $readBaselines.setKey(key, report.endedAt);
  }
}

/** @type {readonly string[]} */
let last = [];

/** Ids of the listed sessions with activity the user hasn't seen (`isUnread()`); the same array while that set holds. */
export const $unreadSessions = computed([$sessions, $sessionReads, $readBaselines], (sessions, reads, baselines) => {
  const ids = sessions
    .filter((s) => isUnread(s, reads[s.id], baselines[baselineKey(s.agentId, s.projectId)]))
    .map((s) => s.id);
  if (ids.length === last.length && ids.every((id, i) => id === last[i])) return last;
  last = ids;
  return ids;
});

/** @param {string} id */
function listed(id) {
  return $sessions.get().some((s) => s.id === id);
}

/**
 * The user sees the session now: its mark becomes `seen = now`, also over a hand mark. Skipped for a
 * session that isn't listed, and when it was seen within the last second.
 * @param {string} id
 * @param {number} [now] ms.
 */
export function markSeen(id, now = Date.now()) {
  const seen = $sessionReads.get()[id]?.seen;
  if (!listed(id) || (typeof seen === 'string' && now - Date.parse(seen) < SEEN_FRESH_MS)) return;
  $sessionReads.setKey(id, { seen: new Date(now).toISOString() });
}

/**
 * Mark as read: `seen = now`; skipped when the session already reads as read.
 * @param {string} id
 * @param {number} [now] ms.
 */
export function markRead(id, now = Date.now()) {
  if (!$unreadSessions.get().includes(id)) return;
  $sessionReads.setKey(id, { seen: new Date(now).toISOString() });
}

/**
 * Mark as unread by hand; it holds until the session is seen or marked read.
 * @param {string} id
 */
export function markUnread(id) {
  if (!listed(id) || $sessionReads.get()[id]?.seen === null) return;
  $sessionReads.setKey(id, { seen: null });
}

/**
 * Mark all as read: every unread session of the project, those behind Show more, marked by hand or
 * running too.
 * @param {string} projectId
 * @param {number} [now] ms.
 */
export function markProjectRead(projectId, now = Date.now()) {
  const unread = new Set($unreadSessions.get());
  for (const s of $sessions.get()) if (s.projectId === projectId && unread.has(s.id)) markRead(s.id, now);
}

/** @param {string} id A removed session's. */
export function forgetRead(id) {
  if ($sessionReads.get()[id] !== undefined) $sessionReads.setKey(id, undefined);
}
