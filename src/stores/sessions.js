import { atom, computed } from 'nanostores';
import { persistentMapStore } from './persistent.js';

/** @typedef {import('../models/types.js').Session} Session */
/** @typedef {import('../models/types.js').SessionStatus} SessionStatus */
/** @typedef {import('../models/types.js').WorktreeFolder} WorktreeFolder */

/** Every agent session, as the backend lists them plus the ones started here; written by `sessionController`. */
export const $sessions = atom(/** @type {Session[]} */ ([]));

/** The backend's list has arrived (`setListedSessions()`); until then `$sessions` is only what started here. */
export const $sessionsLoaded = atom(false);

/**
 * The backend's sessions, at launch.
 * @param {Session[]} sessions
 */
export function setListedSessions(sessions) {
  $sessions.set(sessions);
  $sessionsLoaded.set(true);
}

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

/** The active session's folder (`folderOf()`); notifies only when it changes. */
export const $activeFolder = computed([$sessions, $draftSessions, $activeSessionId], (sessions, drafts, id) =>
  id === null ? null : (sessions.find((s) => s.id === id)?.folder ?? drafts[id] ?? null),
);

/** Every worktree session's folder. */
export const $worktrees = computed($sessions, (sessions) =>
  sessions.flatMap((s) =>
    s.mode === 'worktree' && s.branch
      ? [
          /** @type {WorktreeFolder} */ ({
            sessionId: s.id,
            projectId: s.projectId,
            folder: s.folder,
            branch: s.branch,
            title: s.title,
          }),
        ]
      : [],
  ),
);

/**
 * The session last shown per project id, to come back to it, also after a relaunch. Per window, like
 * the tabs; a draft's id doesn't outlive the launch, so `showProject()` then falls back.
 */
const $lastByProject = persistentMapStore('brama:sessions:last:', (raw) => (typeof raw === 'string' ? raw : null));

$activeSessionId.listen((id) => {
  const projectId = id === null ? null : projectOf(id);
  if (id !== null && projectId !== null) $lastByProject.setKey(projectId, id);
});

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null}
 */
export function projectOf(id) {
  return $sessions.get().find((s) => s.id === id)?.projectId ?? $draftSessions.get()[id] ?? null;
}

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null} Where its agent works: a worktree session's folder in the worktree, else
 *   its project. Paths the agent names are relative to it.
 */
export function folderOf(id) {
  return $sessions.get().find((s) => s.id === id)?.folder ?? $draftSessions.get()[id] ?? null;
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
  const last = $lastByProject.get()[projectId];
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
    folder: projectId,
    worktreePath: null,
    branch: null,
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
  for (const [projectId, last] of Object.entries($lastByProject.get())) {
    if (last === id) $lastByProject.setKey(projectId, undefined);
  }
  if ($activeSessionId.get() === id) {
    $activeSessionId.set(null);
    showProject(session.projectId);
  }
}
