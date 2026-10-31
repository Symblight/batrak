import { closeWorkspace, onWorkspaceChanged, openSessionRoot } from '../ipc/ipc.js';
import { log } from '../logger/logger.js';
import { reportError } from '../notices/notices.js';
import { projectController } from '../project-controller/project-controller.js';
import { $activeSession, $sessions } from '../../stores/sessions/sessions.js';
import { $sessionRoot, $sessionRootOpening, keepRecent, sessionRootAction, setSessionRoot } from '../../stores/session-root/session-root.js';

/** @typedef {import('../../models/types/types.js').Session} Session */
/** @typedef {import('../../models/types/types.js').SessionRoot} SessionRoot */
/** @typedef {import('../../models/types/types.js').WorkspaceChanges} WorkspaceChanges */

/**
 * Worktree sessions whose folder stays open (scan + watcher), the shown one included, like
 * `projectController`'s projects: showing one of them again needs no scan.
 */
const KEEP_OPEN = 3;

/**
 * Keeps the active worktree session's folder open as a backend root for the Files tree
 * (`$sessionRoot`), and the last `KEEP_OPEN` shown. Emits 'fs-change' (CustomEvent<WorkspaceChanges>)
 * when the shown one's files change on disk.
 */
export class SessionRootController extends EventTarget {
  /** @type {Session | null} */
  #previous = null;
  /** Id of the latest show or hide; an open that finishes after a newer one is closed again. */
  #generation = 0;
  /** @type {Map<string, SessionRoot>} Open roots by session id. */
  #roots = new Map();
  /** @type {string[]} Session ids of `#roots`, least recently shown first. */
  #order = [];
  /** @type {(() => void) | null} */
  #unsubscribe = null;

  /** Starts following the active session; idempotent. */
  start() {
    if (this.#unsubscribe) return;
    onWorkspaceChanged((changes) => {
      if (changes.rootId !== $sessionRoot.get()?.rootId) return;
      this.dispatchEvent(new CustomEvent('fs-change', { detail: changes }));
    }).catch((err) => reportError('File watching unavailable', err));
    const active = $activeSession.subscribe((session) => {
      const open = $sessionRoot.get() !== null || $sessionRootOpening.get();
      const action = sessionRootAction(session, this.#previous, open);
      this.#previous = session;
      if (action === 'close') this.#hide();
      else if (action === 'open' && session) this.#show(session);
    });
    // Removed elsewhere (another window): its folder is about to go.
    const listed = $sessions.subscribe((sessions) => {
      for (const id of this.#roots.keys()) {
        if (!sessions.some((s) => s.id === id)) this.forget(id);
      }
    });
    this.#unsubscribe = () => {
      active();
      listed();
    };
  }

  /**
   * Closes a session's root, e.g. before its worktree is deleted.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async forget(id) {
    const root = this.#roots.get(id);
    if (!root) return;
    this.#roots.delete(id);
    this.#order = this.#order.filter((other) => other !== id);
    if ($sessionRoot.get()?.sessionId === id) this.#hide();
    await closeWorkspace(root.rootId).catch(() => {});
  }

  /** @param {Session} session */
  async #show(session) {
    const generation = ++this.#generation;
    const kept = this.#roots.get(session.id);
    if (kept) {
      $sessionRootOpening.set(false);
      this.#keep(kept);
      setSessionRoot(kept);
      return;
    }
    setSessionRoot(null);
    $sessionRootOpening.set(true);
    try {
      await projectController.ready;
      if (generation !== this.#generation) return;
      const opened = await openSessionRoot(session.id);
      const label = (session.worktreePath ?? opened.path).split('/').pop() ?? opened.path;
      const root = { sessionId: session.id, rootId: opened.rootId, path: opened.path, label };
      // Kept only while shown: a late one would push out the root that is.
      if (generation !== this.#generation || !$sessions.get().some((s) => s.id === session.id)) {
        closeWorkspace(opened.rootId).catch(() => {});
        return;
      }
      this.#keep(root);
      setSessionRoot(root);
    } catch (err) {
      // Not checked out yet, gone, or superseded by a newer open: the tree lists the project.
      if (generation === this.#generation) log('debug', `session root not opened: ${err}`);
    } finally {
      if (generation === this.#generation) $sessionRootOpening.set(false);
    }
  }

  /**
   * Keeps a root as the most recently shown, closing the oldest beyond `KEEP_OPEN`.
   * @param {SessionRoot} root
   */
  #keep(root) {
    this.#roots.set(root.sessionId, root);
    const { order, evicted } = keepRecent(this.#order, root.sessionId, KEEP_OPEN);
    this.#order = order;
    for (const id of evicted) {
      const old = this.#roots.get(id);
      this.#roots.delete(id);
      if (old) closeWorkspace(old.rootId).catch(() => {});
    }
  }

  /** The tree lists the project again; the roots stay open. */
  #hide() {
    this.#generation++;
    $sessionRootOpening.set(false);
    setSessionRoot(null);
  }
}

export const sessionRootController = new SessionRootController();
