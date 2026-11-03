import { atom, computed } from 'nanostores';
import { $activeSessionId } from '../sessions/sessions.js';

/** @typedef {import('../../hooks/sessions/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../hooks/sessions/types.js').SessionNotice} SessionNotice */
/** @typedef {import('../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {import('../../hooks/sessions/types.js').AcpSessionUpdate} AcpSessionUpdate */

/** Permission requests waiting for the user, by session id, oldest first. Written by the ACP adapter. */
export const $permissionRequests = atom(/** @type {Readonly<Record<string, readonly PermissionRequest[]>>} */ ({}));

/** Each chat's subagents, by session id, in the order announced. Written by the ACP adapter. */
export const $subagents = atom(/** @type {Readonly<Record<string, readonly Subagent[]>>} */ ({}));

/**
 * The subagent whose read-only chat the agent column shows in place of its chat's: per window, in
 * memory. Shown only while its chat is the active session (`$activeSubagent`).
 */
export const $shownSubagent = atom(/** @type {{ sessionId: string, subagentId: string } | null} */ (null));

/** The active session's subagent the agent column shows, or `null` for the chat itself. */
export const $activeSubagent = computed([$shownSubagent, $activeSessionId, $subagents], (shown, id, all) =>
  shown === null || shown.sessionId !== id ? null : (all[id]?.find((s) => s.id === shown.subagentId) ?? null),
);

/**
 * @param {{ sessionId: string, subagentId: string } | null} shown `null`: back to the chat.
 */
export function showSubagent(shown) {
  $shownSubagent.set(shown);
}

/** What the chat says about each session above its composer, by session id (a draft's too). */
export const $sessionNotices = atom(/** @type {Readonly<Record<string, SessionNotice>>} */ ({}));

/** The active session's oldest pending permission request. */
export const $activePermission = computed([$permissionRequests, $activeSessionId], (requests, id) =>
  id === null ? null : (requests[id]?.[0] ?? null),
);

/** The active session's notice; a queued turn's says when what it waits for waits for the user. */
export const $activeNotice = computed([$sessionNotices, $activeSessionId, $permissionRequests], (notices, id, requests) => {
  const notice = id === null ? null : (notices[id] ?? null);
  const holder = notice?.kind === 'queued' ? notice.holder : undefined;
  if (!holder?.title || !requests[holder.id]?.length) return notice;
  return { ...notice, message: `"${holder.title}" is waiting for your answer` };
});

/**
 * @param {string} sessionId
 * @param {PermissionRequest} request
 */
export function addPermissionRequest(sessionId, request) {
  const all = $permissionRequests.get();
  $permissionRequests.set({ ...all, [sessionId]: [...(all[sessionId] ?? []), request] });
}

/**
 * @param {string} sessionId
 * @param {string} requestId
 */
export function removePermissionRequest(sessionId, requestId) {
  const all = $permissionRequests.get();
  const left = (all[sessionId] ?? []).filter((r) => r.requestId !== requestId);
  const { [sessionId]: _, ...rest } = all;
  $permissionRequests.set(left.length ? { ...rest, [sessionId]: left } : rest);
}

/**
 * The turn ended: the backend answered whatever was still pending.
 * @param {string} sessionId
 */
export function clearPermissionRequests(sessionId) {
  const { [sessionId]: dropped, ...rest } = $permissionRequests.get();
  if (dropped) $permissionRequests.set(rest);
}

/**
 * @param {string} sessionId
 * @param {SessionNotice | null} notice `null` clears it.
 */
export function setSessionNotice(sessionId, notice) {
  const { [sessionId]: current, ...rest } = $sessionNotices.get();
  if (notice === null) {
    if (current) $sessionNotices.set(rest);
  } else if (
    current?.kind !== notice.kind ||
    current.message !== notice.message ||
    current.holder?.id !== notice.holder?.id ||
    current.under !== notice.under ||
    current.offAgent !== notice.offAgent ||
    current.signIn !== notice.signIn
  ) {
    $sessionNotices.set({ ...rest, [sessionId]: notice });
  }
}

/**
 * Takes the session's notice away; an overlap's gives way to the one it covered.
 * @param {string} sessionId
 */
export function dismissSessionNotice(sessionId) {
  setSessionNotice(sessionId, $sessionNotices.get()[sessionId]?.under ?? null);
}

/**
 * A `subagent_update` upserts its subagent: the first announces it, later ones patch it (an
 * omitted field stays, `null` clears it).
 * @param {readonly Subagent[]} subagents
 * @param {AcpSessionUpdate} update
 * @param {string} now ISO time, for a new one.
 * @returns {readonly Subagent[]}
 */
export function applySubagentUpdate(subagents, update, now) {
  const id = update.sessionId;
  if (!id) return subagents;
  const known = subagents.find((s) => s.id === id);
  /** @type {Subagent} */
  const next = { ...(known ?? { id, title: null, description: null, state: null, stopReason: null, cancellable: false, announcedAt: now }) };
  if (update.title !== undefined) next.title = update.title;
  if (update.description !== undefined) next.description = update.description;
  if (update.capabilities !== undefined) next.cancellable = Boolean(update.capabilities?.cancel);
  if (update.state !== undefined) {
    next.state = update.state?.state ?? null;
    const reason = update.state?.stopReason;
    next.stopReason = reason == null ? null : typeof reason === 'string' ? reason : 'error';
  }
  return known ? subagents.map((s) => (s === known ? next : s)) : [...subagents, next];
}

/**
 * @param {string} sessionId
 * @param {AcpSessionUpdate} update A `subagent_update` of the session's.
 */
export function upsertSubagent(sessionId, update) {
  const all = $subagents.get();
  const next = applySubagentUpdate(all[sessionId] ?? [], update, new Date().toISOString());
  if (next !== all[sessionId]) $subagents.set({ ...all, [sessionId]: next });
}

/** @param {string} sessionId */
export function forgetSubagents(sessionId) {
  const { [sessionId]: dropped, ...rest } = $subagents.get();
  if (dropped) $subagents.set(rest);
}
