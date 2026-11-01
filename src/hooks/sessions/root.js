import { projects } from '../projects/projects.js';
import { app } from '../app/app.js';
import { openSessionRoot } from './commands.js';
import { $activeSession, $sessions } from '../../stores/sessions/sessions.js';
import { $sessionRoot, $sessionRootOpening, keepRecent, sessionRootAction, setSessionRoot } from '../../stores/session-root/session-root.js';

/** @typedef {import('../../models/types/types.js').Session} Session */
/** @typedef {import('../../models/types/types.js').SessionRoot} SessionRoot */
/** @typedef {import('../../models/types/types.js').WorkspaceChanges} WorkspaceChanges */

/**
 * Worktree sessions whose folder stays open (scan + watcher), the shown one included, like
 * the `projects` hook's open projects: showing one of them again needs no scan.
 */
const KEEP_OPEN = 3;

/** @type {Session | null} */
let previous = null;
/** Id of the latest show or hide; an open that finishes after a newer one is closed again. */
let generation = 0;
/** @type {Map<string, SessionRoot>} Open roots by session id. */
const roots = new Map();
/** @type {string[]} Session ids of `roots`, least recently shown first. */
let order = [];
/** @type {(() => void) | null} */
let unsubscribe = null;
/** @type {Set<(changes: WorkspaceChanges) => void>} */
const listeners = new Set();

/** The tree lists the project again; the roots stay open. */
function hide() {
  generation++;
  $sessionRootOpening.set(false);
  setSessionRoot(null);
}

/**
 * Keeps a root as the most recently shown, closing the oldest beyond `KEEP_OPEN`.
 * @param {SessionRoot} root
 */
function keep(root) {
  roots.set(root.sessionId, root);
  const kept = keepRecent(order, root.sessionId, KEEP_OPEN);
  order = kept.order;
  for (const id of kept.evicted) {
    const old = roots.get(id);
    roots.delete(id);
    if (old) projects.closeRoot(old.rootId).catch(() => {});
  }
}

/** @param {Session} session */
async function show(session) {
  const mine = ++generation;
  const kept = roots.get(session.id);
  if (kept) {
    $sessionRootOpening.set(false);
    keep(kept);
    setSessionRoot(kept);
    return;
  }
  setSessionRoot(null);
  $sessionRootOpening.set(true);
  try {
    await projects.ready();
    if (mine !== generation) return;
    const opened = await openSessionRoot(session.id);
    const label = (session.worktreePath ?? opened.path).split('/').pop() ?? opened.path;
    const root = { sessionId: session.id, rootId: opened.rootId, path: opened.path, label };
    // Kept only while shown: a late one would push out the root that is.
    if (mine !== generation || !$sessions.get().some((s) => s.id === session.id)) {
      projects.closeRoot(opened.rootId).catch(() => {});
      return;
    }
    keep(root);
    setSessionRoot(root);
  } catch (err) {
    // Not checked out yet, gone, or superseded by a newer open: the tree lists the project.
    if (mine === generation) app.log('debug', `session root not opened: ${err}`);
  } finally {
    if (mine === generation) $sessionRootOpening.set(false);
  }
}

/**
 * Closes a session's root, e.g. before its worktree is deleted.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function forget(id) {
  const root = roots.get(id);
  if (!root) return;
  roots.delete(id);
  order = order.filter((other) => other !== id);
  if ($sessionRoot.get()?.sessionId === id) hide();
  await projects.closeRoot(root.rootId).catch(() => {});
}

/**
 * Keeps the active worktree session's folder open as a backend root for the Files tree
 * (`$sessionRoot`), and the last `KEEP_OPEN` shown. `onFsChange` listeners hear when the shown
 * one's files change on disk.
 */
export const root = Object.freeze({
  /** Starts following the active session; idempotent. */
  start() {
    if (unsubscribe) return;
    projects.onRootsChanged((changes) => {
      if (changes.rootId !== $sessionRoot.get()?.rootId) return;
      for (const listener of [...listeners]) listener(changes);
    }).catch((err) => app.reportError('File watching unavailable', err));
    const active = $activeSession.subscribe((session) => {
      const open = $sessionRoot.get() !== null || $sessionRootOpening.get();
      const action = sessionRootAction(session, previous, open);
      previous = session;
      if (action === 'close') hide();
      else if (action === 'open' && session) show(session);
    });
    // Removed elsewhere (another window): its folder is about to go.
    const listed = $sessions.subscribe((sessions) => {
      for (const id of roots.keys()) {
        if (!sessions.some((s) => s.id === id)) forget(id);
      }
    });
    unsubscribe = () => {
      active();
      listed();
    };
  },

  forget,

  /**
   * @param {(changes: WorkspaceChanges) => void} listener
   * @returns {() => void} Stops listening.
   */
  onFsChange(listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
});
