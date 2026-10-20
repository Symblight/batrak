import { atom, computed } from 'nanostores';
import { $activeSessionId } from './sessions.js';

/** @typedef {import('../models/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../models/types.js').SessionNotice} SessionNotice */

/** Permission requests waiting for the user, by session id, oldest first. Written by the ACP adapter. */
export const $permissionRequests = atom(/** @type {Readonly<Record<string, readonly PermissionRequest[]>>} */ ({}));

/** What the chat says about each session above its composer, by session id (a draft's too). */
export const $sessionNotices = atom(/** @type {Readonly<Record<string, SessionNotice>>} */ ({}));

/** Sessions that got output while not shown; cleared when shown. In memory only. */
export const $unreadSessions = atom(/** @type {readonly string[]} */ ([]));

/**
 * A turn ended in a session; unless it's the one shown, its output is new.
 * @param {string} sessionId
 */
export function markUnread(sessionId) {
  const unread = $unreadSessions.get();
  if (sessionId !== $activeSessionId.get() && !unread.includes(sessionId)) $unreadSessions.set([...unread, sessionId]);
}

$activeSessionId.listen((id) => {
  const unread = $unreadSessions.get();
  if (id !== null && unread.includes(id)) $unreadSessions.set(unread.filter((u) => u !== id));
});

/** The active session's oldest pending permission request. */
export const $activePermission = computed([$permissionRequests, $activeSessionId], (requests, id) =>
  id === null ? null : (requests[id]?.[0] ?? null),
);

/** The active session's notice. */
export const $activeNotice = computed([$sessionNotices, $activeSessionId], (notices, id) =>
  id === null ? null : (notices[id] ?? null),
);

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
  } else if (current?.kind !== notice.kind || current.message !== notice.message) {
    $sessionNotices.set({ ...rest, [sessionId]: notice });
  }
}
