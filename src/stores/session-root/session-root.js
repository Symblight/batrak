import { atom, computed } from 'nanostores';
import { $workspace } from '../workspace/workspace.js';

/** @typedef {import('../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../hooks/sessions/types.js').SessionRoot} SessionRoot */
/** @typedef {import('../../hooks/sessions/types.js').TreeRoot} TreeRoot */

/** The active worktree session's folder, open as a backend root for the Files tree. Per window. */
export const $sessionRoot = atom(/** @type {SessionRoot | null} */ (null));

/** A session root is being scanned: the tree shows its spinner. */
export const $sessionRootOpening = atom(false);

/** The folder the Files tree lists: the active worktree session's while it's open, else the project. */
export const $treeRoot = computed([$sessionRoot, $workspace], (session, workspace) =>
  session
    ? /** @type {TreeRoot} */ ({ rootId: session.rootId, path: session.path, label: session.label })
    : /** @type {TreeRoot} */ ({ rootId: workspace?.rootId ?? null, path: workspace?.path ?? null, label: null }),
);

/** @param {SessionRoot | null} root */
export function setSessionRoot(root) {
  $sessionRoot.set(root);
}

/**
 * What to do with the session root when the active session changes or reports a status. Every start
 * passes through `preparing`; an open that failed (not checked out yet) is tried again after it.
 * @param {Session | null} session The active session; `null` for a draft or none.
 * @param {Session | null} previous The active session before this change.
 * @param {boolean} open Its root is open, or opening.
 * @returns {'open' | 'close' | 'keep'}
 */
export function sessionRootAction(session, previous, open) {
  if (session === null || session.mode !== 'worktree' || session.worktreePath === null) return 'close';
  if (session.id !== previous?.id) return 'open';
  if (open) return 'keep';
  return previous.status === 'preparing' && session.status !== 'preparing' ? 'open' : 'keep';
}

/**
 * The open session roots after `id` was shown: newest last, the oldest beyond `limit` closed.
 * @param {readonly string[]} order Session ids, least recently shown first.
 * @param {string} id
 * @param {number} limit
 * @returns {{ order: string[], evicted: string[] }}
 */
export function keepRecent(order, id, limit) {
  const next = [...order.filter((other) => other !== id), id];
  const cut = Math.max(0, next.length - limit);
  return { order: next.slice(cut), evicted: next.slice(0, cut) };
}
