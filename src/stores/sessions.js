import { atom, computed } from 'nanostores';

/** @typedef {import('../models/types.js').Session} Session */
/** @typedef {import('../models/types.js').SessionStatus} SessionStatus */

/** Every agent session, as the backend lists them plus the ones started here; written by `sessionController`. */
export const $sessions = atom(/** @type {Session[]} */ ([]));

/**
 * New sessions with no message yet, session id → project id. Not listed; the first message makes one
 * a `Session` (`startSession()`).
 */
export const $draftSessions = atom(/** @type {Readonly<Record<string, string>>} */ ({}));

/** The session in the chat: a listed session or a draft. Also the chat's conversation id. */
export const $activeSessionId = atom(/** @type {string | null} */ (null));

/** The active session's record; `null` while it's a draft (or none is active). */
export const $activeSession = computed([$sessions, $activeSessionId], (sessions, id) =>
  id === null ? null : (sessions.find((s) => s.id === id) ?? null),
);

/** @type {Map<string, string>} The session last shown per project id, to come back to it. */
const lastByProject = new Map();

$activeSessionId.listen((id) => {
  const projectId = id === null ? null : projectOf(id);
  if (id !== null && projectId !== null) lastByProject.set(projectId, id);
});

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null}
 */
export function projectOf(id) {
  return $sessions.get().find((s) => s.id === id)?.projectId ?? $draftSessions.get()[id] ?? null;
}

/** @param {string | null} id */
export function selectSession(id) {
  $activeSessionId.set(id);
}

/**
 * Opens a draft session in a project; a draft of it that's still empty is reused.
 * @param {string} projectId
 * @returns {string} The draft's id.
 */
export function newSession(projectId) {
  const drafts = $draftSessions.get();
  let id = Object.keys(drafts).find((d) => drafts[d] === projectId);
  if (id === undefined) {
    id = crypto.randomUUID();
    $draftSessions.set({ ...drafts, [id]: projectId });
  }
  $activeSessionId.set(id);
  return id;
}

/**
 * Keeps the active session when it's the project's, else shows the project's last session, its
 * newest, or a new draft.
 * @param {string} projectId
 */
export function showProject(projectId) {
  const active = $activeSessionId.get();
  if (active !== null && projectOf(active) === projectId) return;
  const last = lastByProject.get(projectId);
  if (last !== undefined && projectOf(last) === projectId) {
    $activeSessionId.set(last);
    return;
  }
  const newest = $sessions
    .get()
    .filter((s) => s.projectId === projectId)
    .reduce((/** @type {Session | null} */ a, s) => (a === null || s.createdAt > a.createdAt ? s : a), null);
  if (newest) $activeSessionId.set(newest.id);
  else newSession(projectId);
}

/**
 * A draft's first message: it becomes a listed session, `preparing` until the backend reports.
 * @param {string} id
 * @param {Pick<Session, 'title' | 'agentId' | 'model' | 'mode'>} fields
 */
export function startSession(id, fields) {
  const { [id]: projectId, ...drafts } = $draftSessions.get();
  if (projectId === undefined) return;
  $draftSessions.set(drafts);
  /** @type {Session} */
  const session = {
    id,
    projectId,
    status: 'preparing',
    worktreePath: null,
    baseCommit: null,
    createdAt: new Date().toISOString(),
    ...fields,
  };
  $sessions.set([session, ...$sessions.get()]);
}

/**
 * The backend's record of a session replaces the one started here.
 * @param {Session} session
 */
export function upsertSession(session) {
  const sessions = $sessions.get();
  const known = sessions.some((s) => s.id === session.id);
  $sessions.set(known ? sessions.map((s) => (s.id === session.id ? session : s)) : [session, ...sessions]);
}

/**
 * The backend refused to create a started session: it's a draft of its project again.
 * @param {string} id
 */
export function revertToDraft(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  $sessions.set($sessions.get().filter((s) => s !== session));
  $draftSessions.set({ ...$draftSessions.get(), [id]: session.projectId });
}

/**
 * @param {string} id Ignored unless it's a listed session.
 * @param {SessionStatus} status
 */
export function setSessionStatus(id, status) {
  const sessions = $sessions.get();
  const session = sessions.find((s) => s.id === id);
  if (session && session.status !== status) $sessions.set(sessions.map((s) => (s === session ? { ...s, status } : s)));
}

/**
 * A removed session leaves the list; when it was shown, the project's last or newest session (or a
 * new draft) takes its place.
 * @param {string} id
 */
export function removeSession(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  $sessions.set($sessions.get().filter((s) => s !== session));
  for (const [projectId, last] of lastByProject) {
    if (last === id) lastByProject.delete(projectId);
  }
  if ($activeSessionId.get() === id) {
    $activeSessionId.set(null);
    showProject(session.projectId);
  }
}
