import { atom, computed } from 'nanostores';
import { persistentMapStore, persistentStore } from '../persistent/persistent.js';
import { $workspaces, MAIN } from '../workspaces/workspaces.js';
import { folderOfWorkspace } from '../../hooks/workspaces/folder.js';

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../hooks/sessions/types.js').SessionStatus} SessionStatus */
/** @typedef {import('../../hooks/sessions/types.js').DraftSession} DraftSession */

/** Every agent session, as the backend lists them (stored, then synced with the agents) plus the ones started here; written by the `sessions` hook. */
export const $sessions = atom(/** @type {Session[]} */ ([]));

/** Ids of the sessions pinned to the top of their project's list. Shared by every window. */
export const $pinnedSessions = persistentStore('batrak:sessions:pinned', /** @type {string[]} */ ([]), {
  parse: (raw) => (Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : null),
});

/**
 * @param {string} id
 * @param {boolean} pinned
 */
export function setSessionPinned(id, pinned) {
  const ids = $pinnedSessions.get();
  if (ids.includes(id) === pinned) return;
  $pinnedSessions.set(pinned ? [...ids, id] : ids.filter((p) => p !== id));
}

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
 * A sync's sessions of a project replace its listed ones; a session started here that the backend
 * doesn't list yet stays. When the project shows the draft it got for want of its last session, and
 * that session is listed now, it's shown instead.
 * @param {string} projectId
 * @param {Session[]} sessions
 */
export function setProjectSessions(projectId, sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  const creating = $sessions.get().filter((s) => s.projectId === projectId && !ids.has(s.id) && s.status === 'preparing');
  $sessions.set([...$sessions.get().filter((s) => s.projectId !== projectId), ...creating, ...sessions]);
  const active = $activeSessionId.get();
  const last = $lastByFolder.get()[projectId];
  if (active !== null && active === stopgapDraft && last !== undefined && ids.has(last)) $activeSessionId.set(last);
}

/**
 * New sessions with no message yet, by session id: their project and workspace. Not listed; the
 * first message makes one a `Session` (`startSession()`).
 */
export const $draftSessions = atom(/** @type {Readonly<Record<string, DraftSession>>} */ ({}));

/**
 * The workspace a chat belongs to: its workspace's id, `main` for Main.
 * @param {Pick<Session, 'workspaceId'>} session
 */
export const workspaceOfSession = (session) => session.workspaceId ?? MAIN;

/**
 * Where a draft's agent will work: its workspace's folder (its project while the list loads).
 * @param {DraftSession} draft
 * @param {readonly import('../../hooks/workspaces/types.js').Workspace[]} workspaces
 */
const draftFolder = (draft, workspaces) => folderOfWorkspace(draft.projectId, draft.workspaceId, workspaces) ?? draft.projectId;

/** The session in the chat: a listed session or a draft. Also the chat's conversation id. */
export const $activeSessionId = atom(/** @type {string | null} */ (null));

/** The active session's record; `null` while it's a draft (or none is active). */
export const $activeSession = computed([$sessions, $activeSessionId], (sessions, id) =>
  id === null ? null : (sessions.find((s) => s.id === id) ?? null),
);

/** The active session's folder (`folderOf()`); notifies only when it changes. */
export const $activeFolder = computed([$sessions, $draftSessions, $workspaces, $activeSessionId], (sessions, drafts, workspaces, id) => {
  if (id === null) return null;
  const draft = drafts[id];
  return sessions.find((s) => s.id === id)?.folder ?? (draft ? draftFolder(draft, workspaces) : null);
});

/**
 * The session last shown per folder (Main's: the project path; a workspace's: its folder), to come
 * back to it, also after a relaunch. Per window, like the tabs; a draft's id doesn't outlive the
 * launch, so `showWorkspace()` then falls back.
 */
const $lastByFolder = persistentMapStore('batrak:sessions:last:', (raw) => (typeof raw === 'string' ? raw : null));

/** The draft `showWorkspace()` opened because the workspace's last session wasn't listed (yet). */
let stopgapDraft = /** @type {string | null} */ (null);

$activeSessionId.listen((id) => {
  if (id !== stopgapDraft) stopgapDraft = null;
  // Listed sessions only: a draft doesn't outlive the launch, and one shown while the list loads
  // mustn't replace the session to come back to.
  const folder = id === null ? null : ($sessions.get().find((s) => s.id === id)?.folder ?? null);
  if (id !== null && folder !== null) $lastByFolder.setKey(folder, id);
});

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null}
 */
export function projectOf(id) {
  return $sessions.get().find((s) => s.id === id)?.projectId ?? $draftSessions.get()[id]?.projectId ?? null;
}

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null} Its workspace's id (`main` for Main); `null` for an unknown id.
 */
export function workspaceOf(id) {
  const session = $sessions.get().find((s) => s.id === id);
  return session ? workspaceOfSession(session) : ($draftSessions.get()[id]?.workspaceId ?? null);
}

/**
 * @param {string} id A session's or a draft's.
 * @returns {string | null} Where its agent works: a worktree session's folder in the worktree, else
 *   its project. Paths the agent names are relative to it.
 */
export function folderOf(id) {
  const draft = $draftSessions.get()[id];
  return $sessions.get().find((s) => s.id === id)?.folder ?? (draft ? draftFolder(draft, $workspaces.get()) : null);
}

/** @param {string | null} id */
export function selectSession(id) {
  $activeSessionId.set(id);
}

/**
 * Opens a draft session in a project's workspace, reusing a draft of that workspace (New chat): the
 * shown one, else the last added (a refused chat back as a draft beside one opened meanwhile).
 * @param {string} projectId
 * @param {string} [workspaceId] `main` (default) for Main.
 * @returns {string} The draft's id.
 */
export function newSession(projectId, workspaceId = MAIN) {
  const drafts = $draftSessions.get();
  const ours = Object.keys(drafts).filter((d) => drafts[d].projectId === projectId && drafts[d].workspaceId === workspaceId);
  const active = $activeSessionId.get();
  let id = active !== null && ours.includes(active) ? active : ours.at(-1);
  if (id === undefined) {
    id = crypto.randomUUID();
    $draftSessions.set({ ...drafts, [id]: { projectId, workspaceId } });
  }
  $activeSessionId.set(id);
  return id;
}

/**
 * Keeps the active session when it's the workspace's, else shows the workspace's last session, its
 * newest, or a new draft.
 * @param {string} projectId
 * @param {string} workspaceId `main` for Main.
 * @param {string | null} folder Its folder (Main's: the project's).
 */
export function showWorkspace(projectId, workspaceId, folder) {
  /** @param {string} id */
  const ours = (id) => projectOf(id) === projectId && workspaceOf(id) === workspaceId;
  const active = $activeSessionId.get();
  if (active !== null && ours(active)) return;
  const last = folder === null ? undefined : $lastByFolder.get()[folder];
  if (last !== undefined && ours(last)) {
    $activeSessionId.set(last);
    return;
  }
  const newest = $sessions
    .get()
    .filter((s) => s.projectId === projectId && workspaceOfSession(s) === workspaceId)
    .reduce((/** @type {Session | null} */ a, s) => (a === null || s.createdAt > a.createdAt ? s : a), null);
  if (newest) $activeSessionId.set(newest.id);
  else stopgapDraft = newSession(projectId, workspaceId);
}

/**
 * Forgets the drafts of a workspace that's gone (deleted).
 * @param {string} workspaceId
 */
export function dropDrafts(workspaceId) {
  const drafts = $draftSessions.get();
  const kept = Object.fromEntries(Object.entries(drafts).filter(([, d]) => d.workspaceId !== workspaceId));
  if (Object.keys(kept).length !== Object.keys(drafts).length) $draftSessions.set(kept);
}

/**
 * A draft's first message: it becomes a listed session, `preparing` until the backend reports.
 * @param {string} id
 * @param {Pick<Session, 'title' | 'agentId' | 'config'>} fields
 * @param {string} [workspaceId] Where it's created, when not in the draft's own workspace (`main` for Main).
 */
export function startSession(id, fields, workspaceId) {
  const { [id]: found, ...drafts } = $draftSessions.get();
  if (found === undefined) return;
  const draft = { ...found, workspaceId: workspaceId ?? found.workspaceId };
  const { projectId } = draft;
  $draftSessions.set(drafts);
  const now = new Date().toISOString();
  /** @type {Session} */
  const session = {
    id,
    projectId,
    status: 'preparing',
    folder: draftFolder(draft, $workspaces.get()),
    workspaceId: draft.workspaceId === MAIN ? null : draft.workspaceId,
    branch: null,
    createdAt: now,
    lastActivityAt: now,
    titleSource: 'prompt',
    agentTitle: null,
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
 * A started session goes into the workspace created for it (New worktree) before the backend has it.
 * @param {string} id
 * @param {Pick<import('../../hooks/workspaces/types.js').Workspace, 'id' | 'folder' | 'branch'>} workspace
 */
export function moveSession(id, workspace) {
  const sessions = $sessions.get();
  if (!sessions.some((s) => s.id === id)) return;
  const { id: workspaceId, folder, branch } = workspace;
  $sessions.set(sessions.map((s) => (s.id === id ? { ...s, workspaceId, folder, branch } : s)));
}

/**
 * The backend refused to create a started session: it's a draft of its project again, also beside a
 * draft its workspace got meanwhile (it holds the user's text; `newSession()` then prefers it).
 * @param {string} id
 */
export function revertToDraft(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  $sessions.set($sessions.get().filter((s) => s !== session));
  $draftSessions.set({ ...$draftSessions.get(), [id]: { projectId: session.projectId, workspaceId: workspaceOfSession(session) } });
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
 * The backend stamped the session's activity (a prompt, output, a turn's end or failure). The later of
 * the stamps is kept: two can arrive out of order. Times are compared as times, not strings.
 * @param {string} id Ignored unless it's a listed session.
 * @param {string} at ISO time, the backend's stamp.
 */
export function touchSession(id, at) {
  const sessions = $sessions.get();
  const session = sessions.find((s) => s.id === id);
  const time = Date.parse(at);
  if (!session || Number.isNaN(time) || Date.parse(session.lastActivityAt) >= time) return;
  $sessions.set(sessions.map((s) => (s === session ? { ...s, lastActivityAt: at } : s)));
}

/**
 * Forgets which session a folder last showed, e.g. when its workspace is deleted.
 * @param {string} folder
 */
export function forgetLastSession(folder) {
  if (folder in $lastByFolder.get()) $lastByFolder.setKey(folder, undefined);
}

/**
 * A removed session leaves the list; when it was shown, its workspace's last or newest session (or a
 * new draft) takes its place.
 * @param {string} id
 */
export function removeSession(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  $sessions.set($sessions.get().filter((s) => s !== session));
  setSessionPinned(id, false);
  for (const [folder, last] of Object.entries($lastByFolder.get())) {
    if (last === id) $lastByFolder.setKey(folder, undefined);
  }
  if ($activeSessionId.get() === id) {
    $activeSessionId.set(null);
    showWorkspace(session.projectId, workspaceOfSession(session), session.folder);
  }
}
