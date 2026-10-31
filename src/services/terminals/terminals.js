import {
  closeWindowTerminals,
  getHomeDir,
  terminalAck,
  terminalAttach,
  terminalBusy,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
} from '../ipc/ipc.js';
import { reportError } from '../notices/notices.js';
import { projectController } from '../project-controller/project-controller.js';
import { sessionController } from '../session-controller/session-controller.js';
import { $projectTabs, closeProjectTab } from '../../stores/editor/editor.js';
import { $activeFolder, $sessions } from '../../stores/sessions/sessions.js';
import {
  $terminals,
  forgetTerminal,
  openTerminal,
  terminalExited,
  terminalFailed,
  terminalRestarting,
  terminalStarted,
} from '../../stores/terminals/terminals.js';
import { $workspace } from '../../stores/workspace/workspace.js';
import { terminalTabId } from '../../models/tab-ids/tab-ids.js';

/** @typedef {import('../../models/types/types.js').Session} Session */
/** @typedef {import('../../models/types/types.js').TerminalBusy} TerminalBusy */
/** @typedef {import('../../models/types/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../models/types/types.js').TerminalLink} TerminalLink */
/** @typedef {import('../../models/types/types.js').TerminalSink} TerminalSink */

/**
 * @typedef {Object} TerminalFolder
 * @property {string} cwd
 * @property {string | null} fallback Where to start when `cwd` doesn't exist.
 */

/**
 * A terminal view's stream, from its `connect()` until its `dispose()`.
 * @typedef {Object} Route
 * @property {TerminalSink} sink
 * @property {{ cols: number, rows: number }} size The view's last.
 * @property {boolean} disposed
 * @property {number} undrawn Bytes handed to the view that it hasn't drawn yet.
 */

/**
 * Drawn output is acknowledged in steps of this many bytes; well under the backend's
 * `FLOW_RESUME_AT`, or a paused shell would wait for an acknowledgement that never comes.
 */
export const ACK_EVERY = 8 * 1024;

const encoder = new TextEncoder();

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Where New Terminal starts: the active session's folder (a draft's is its project), else the
 * project, with the project as fallback; with no project, the home folder.
 * @param {{ activeFolder: string | null, project: string | null, home: string }} where
 * @returns {TerminalFolder}
 */
export function newTerminalFolder({ activeFolder, project, home }) {
  if (project === null) return { cwd: home, fallback: null };
  return { cwd: activeFolder ?? project, fallback: project };
}

/**
 * Where Project Terminal starts: always the project folder, with the project as fallback; with no
 * project, the home folder.
 * @param {{ project: string | null, home: string }} where
 * @returns {TerminalFolder}
 */
export function projectTerminalFolder({ project, home }) {
  if (project === null) return { cwd: home, fallback: null };
  return { cwd: project, fallback: project };
}

/**
 * Where a session's Open in → Terminal starts.
 * @param {Session} session
 * @returns {TerminalFolder}
 */
export function sessionTerminalFolder(session) {
  return { cwd: session.folder, fallback: session.projectId };
}

/**
 * A folder's name for a terminal's title: a worktree's folder is named after the worktree, as the
 * Files tree's root row.
 * @param {string} folder Absolute.
 * @param {readonly Session[]} sessions
 */
export function folderLabel(folder, sessions) {
  const worktree = sessions.find((s) => {
    const root = s.worktreePath;
    return root !== null && folder.startsWith(root) && ['', '/', '\\'].includes(folder.charAt(root.length));
  })?.worktreePath;
  return basename(worktree ?? folder);
}

/**
 * Terminal tabs' shells: opens them in the right folder, streams them to their views, closes a
 * shell when its tab closes (one tab, Close Others / All, its project removed) and a tab when its
 * shell exits with code 0.
 */
class TerminalController {
  /** A previous page load's shells are closed before any opens. */
  #ready = closeWindowTerminals().catch((err) => reportError('Closing previous terminals failed', err));
  /** @type {Map<string, Route>} The view each terminal streams to, by terminal id. */
  #routes = new Map();
  /** @type {Map<string, { pending: Uint8Array[], sending: boolean }>} Input waiting while a write is in flight. */
  #input = new Map();
  /** @type {Map<string, Promise<boolean>>} Shells starting, so a second view doesn't start another. */
  #opening = new Map();
  /** @type {Map<string, number>} Drawn bytes not acknowledged yet, by terminal id. */
  #drawn = new Map();
  #started = false;

  /** Closes a terminal once its tab is gone from its project's tabs. */
  start() {
    if (this.#started) return;
    this.#started = true;
    $projectTabs.listen((projects) => {
      const gone = Object.entries($terminals.get())
        .filter(([id, t]) => !t.sessionId && !projects[t.projectPath ?? '']?.paths.includes(terminalTabId(id)))
        .map(([id]) => id);
      if (gone.length) this.#close(gone);
    });
    // A session's CLI is closed by the backend (`session_close_cli`); only its stream is dropped here.
    $terminals.listen((terminals) => {
      for (const id of [...this.#routes.keys(), ...this.#input.keys()]) {
        if (!terminals[id]) this.#forget(id);
      }
    });
  }

  /** New Terminal: in the active session's folder, the project, or home. */
  async newTerminal() {
    const project = $workspace.get()?.path ?? null;
    const home = project === null ? await getHomeDir() : '';
    const { cwd, fallback } = newTerminalFolder({ activeFolder: $activeFolder.get(), project, home });
    openTerminal(cwd, fallback, folderLabel(cwd, $sessions.get()));
  }

  /** Project Terminal: always in the project root folder, or home if no project. */
  async projectTerminal() {
    const project = $workspace.get()?.path ?? null;
    const home = project === null ? await getHomeDir() : '';
    const { cwd, fallback } = projectTerminalFolder({ project, home });
    openTerminal(cwd, fallback, folderLabel(cwd, $sessions.get()));
  }

  /**
   * Open in → Terminal: in the session's folder, among its project's tabs (shown first, with the session).
   * @param {string} sessionId
   */
  async sessionTerminal(sessionId) {
    const session = $sessions.get().find((s) => s.id === sessionId);
    if (!session) return;
    try {
      await projectController.activate(session.projectId);
    } catch (err) {
      reportError('Opening project failed', err);
      return;
    }
    sessionController.select(session.id);
    const { cwd, fallback } = sessionTerminalFolder(session);
    openTerminal(cwd, fallback, folderLabel(cwd, $sessions.get()));
  }

  /**
   * Streams a terminal into a view, starting its shell at the view's size the first time.
   * @type {import('../../models/types/types.js').TerminalConnect}
   */
  connect = (id, size, sink) => {
    /** @type {Route} */
    const route = { sink, size, disposed: false, undrawn: 0 };
    this.#routes.set(id, route);
    this.#attach(id, route);
    return {
      write: (data) => this.#write(id, data),
      resize: (cols, rows) => {
        route.size = { cols, rows };
        if ($terminals.get()[id]?.status === 'running') terminalResize(id, cols, rows).catch(() => {});
      },
      dispose: () => {
        route.disposed = true;
        if (this.#routes.get(id) === route) this.#routes.delete(id);
        // A disposed screen never draws the rest.
        this.#ack(id, route.undrawn, true);
        route.undrawn = 0;
      },
    };
  };

  /**
   * @param {string} id
   * @param {Route} route
   */
  async #attach(id, route) {
    await this.#ready;
    // A session's CLI that didn't start has no terminal in the backend: its view shows why.
    if ($terminals.get()[id]?.sessionId && $terminals.get()[id]?.status === 'failed') return;
    if ($terminals.get()[id]?.status === 'starting' && !(await this.#open(id, route.size))) return;
    this.#flush(id);
    if (route.disposed || !$terminals.get()[id]) return;
    const { cols, rows } = route.size;
    if ($terminals.get()[id]?.status === 'running') await terminalResize(id, cols, rows).catch(() => {});
    try {
      await terminalAttach(
        id,
        (bytes) => {
          if (route.disposed) {
            this.#ack(id, bytes.length);
            return;
          }
          route.undrawn += bytes.length;
          route.sink.output(bytes, () => {
            if (route.disposed) return;
            route.undrawn -= bytes.length;
            this.#ack(id, bytes.length);
          });
        },
        (exit) => {
          if (!route.disposed) route.sink.exit(exit);
          this.#exited(id, exit);
        },
      );
    } catch (err) {
      // Closed meanwhile; anything else is the backend's to report.
      if ($terminals.get()[id]) terminalFailed(id, String(err));
    }
  }

  /**
   * @param {string} id
   * @param {number} bytes Drawn (or never to be).
   * @param {boolean} [now] Don't wait for `ACK_EVERY`.
   */
  #ack(id, bytes, now = false) {
    const drawn = (this.#drawn.get(id) ?? 0) + bytes;
    if (drawn < ACK_EVERY && !(now && drawn > 0)) {
      this.#drawn.set(id, drawn);
      return;
    }
    this.#drawn.delete(id);
    terminalAck(id, drawn).catch(() => {});
  }

  /**
   * Starts a terminal's shell, once however many views ask meanwhile.
   * @param {string} id
   * @param {{ cols: number, rows: number }} size
   * @returns {Promise<boolean>} It started.
   */
  #open(id, size) {
    let opening = this.#opening.get(id);
    if (!opening) {
      opening = this.#start(id, size).finally(() => this.#opening.delete(id));
      this.#opening.set(id, opening);
    }
    return opening;
  }

  /**
   * @param {string} id
   * @param {{ cols: number, rows: number }} size
   * @returns {Promise<boolean>} It started.
   */
  async #start(id, { cols, rows }) {
    const info = $terminals.get()[id];
    if (!info) return false;
    try {
      const opened = await terminalOpen(id, info.cwd, info.fallback, cols, rows);
      terminalStarted(id, opened, `${opened.shell} — ${folderLabel(opened.cwd, $sessions.get())}`);
      return true;
    } catch (err) {
      terminalFailed(id, String(err));
      return false;
    }
  }

  /**
   * Exit code 0 closes the tab, wherever it is; anything else keeps it, with Restart.
   * @param {string} id
   * @param {TerminalExit} exit
   */
  #exited(id, exit) {
    const info = $terminals.get()[id];
    if (!info || info.status === 'exited') return;
    if (info.sessionId) terminalExited(id, exit);
    else if (exit.code === 0 && exit.signal === null) closeProjectTab(info.projectPath, terminalTabId(id));
    else terminalExited(id, exit);
  }

  /**
   * A fresh shell in an exited or failed terminal's tab, in the same folder, its output cleared.
   * @param {string} id
   */
  async restart(id) {
    const info = $terminals.get()[id];
    // A session's CLI starts again through its session (`sessionController.restartCli()`).
    if (!info || info.sessionId || info.status === 'running' || info.status === 'starting') return;
    const route = this.#routes.get(id);
    terminalRestarting(id);
    if (!route) return; // its view starts it when shown
    route.sink.reset();
    // A failed terminal was never attached; an exited one keeps its attachment across the restart.
    if (info.status === 'failed') this.#attach(id, route);
    else if (await this.#open(id, route.size)) this.#flush(id);
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<TerminalBusy[]>} Those running a program other than their shell.
   */
  busy = (ids) => (ids.length ? terminalBusy(ids).catch(() => []) : Promise.resolve([]));

  /**
   * Input goes out one write at a time, so it reaches the shell in order; what's typed meanwhile
   * goes in the next one.
   * @param {string} id
   * @param {string | Uint8Array} data Typed text, or raw bytes.
   */
  #write(id, data) {
    const input = this.#input.get(id) ?? { pending: [], sending: false };
    this.#input.set(id, input);
    input.pending.push(typeof data === 'string' ? encoder.encode(data) : data);
    this.#flush(id);
  }

  /**
   * Sends the input typed so far, unless a write is in flight (it sends the rest when done) or the
   * shell isn't running yet.
   * @param {string} id
   */
  #flush(id) {
    const input = this.#input.get(id);
    if (!input || input.sending || !input.pending.length || $terminals.get()[id]?.status !== 'running') return;
    const chunk = new Uint8Array(input.pending.reduce((n, bytes) => n + bytes.length, 0));
    input.pending.reduce((at, bytes) => (chunk.set(bytes, at), at + bytes.length), 0);
    input.pending = [];
    input.sending = true;
    terminalWrite(id, chunk)
      .catch(() => {})
      .finally(() => {
        input.sending = false;
        this.#flush(id);
      });
  }

  /** @param {string} id */
  #forget(id) {
    this.#routes.delete(id);
    this.#input.delete(id);
    this.#drawn.delete(id);
  }

  /** @param {string[]} ids */
  #close(ids) {
    for (const id of ids) {
      forgetTerminal(id);
      this.#forget(id);
    }
    this.#ready.then(() => terminalClose(ids)).catch((err) => reportError('Closing terminals failed', err));
  }
}

export const terminalController = new TerminalController();
