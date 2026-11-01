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
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { tabs } from '../tabs/tabs.js';
import { folderLabel, newTerminalFolder, projectTerminalFolder, sessionTerminalFolder, shellPaths } from './rules.js';

/** @typedef {import('../sessions/types.js').Session} Session */
/** @typedef {import('./types.js').TerminalBusy} TerminalBusy */
/** @typedef {import('./types.js').TerminalConnect} TerminalConnect */
/** @typedef {import('./types.js').TerminalExit} TerminalExit */
/** @typedef {import('./types.js').TerminalOpened} TerminalOpened */
/** @typedef {import('./types.js').TerminalSink} TerminalSink */
/** @typedef {import('./rules.js').TerminalFolder} TerminalFolder */

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

/** @type {Promise<void> | null} A previous page load's shells being closed: before any opens. */
let previous = null;
/** @type {Map<string, Route>} The view each terminal streams to, by terminal id. */
const routes = new Map();
/** @type {Map<string, { pending: Uint8Array[], sending: boolean }>} Input waiting while a write is in flight. */
const input = new Map();
/** @type {Map<string, Promise<boolean>>} Shells starting, so a second view doesn't start another. */
const opening = new Map();
/** @type {Map<string, number>} Drawn bytes not acknowledged yet, by terminal id. */
const drawn = new Map();

/** @returns {Promise<void>} */
function previousClosed() {
  previous ??= ipc.invoke('close_window_terminals').catch((err) => app.reportError('Closing previous terminals failed', err));
  return previous;
}

/** @param {TerminalFolder} folder */
function openIn({ cwd, fallback }) {
  openTerminal(cwd, fallback, folderLabel(cwd, $sessions.get()));
}

/** @param {string} id */
function forget(id) {
  routes.delete(id);
  input.delete(id);
  drawn.delete(id);
}

/** @param {string[]} ids Terminals whose tabs are gone. */
function release(ids) {
  for (const id of ids) {
    forgetTerminal(id);
    forget(id);
  }
  previousClosed()
    .then(() => close(ids))
    .catch((err) => app.reportError('Closing terminals failed', err));
}

/**
 * Hangs up the terminals' shells and what runs in their foreground.
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
function close(ids) {
  return ipc.invoke('terminal_close', { ids });
}

/**
 * @param {string} id
 * @param {number} bytes Drawn (or never to be).
 * @param {boolean} [now] Don't wait for `ACK_EVERY`.
 */
function ack(id, bytes, now = false) {
  const total = (drawn.get(id) ?? 0) + bytes;
  if (total < ACK_EVERY && !(now && total > 0)) {
    drawn.set(id, total);
    return;
  }
  drawn.delete(id);
  ipc.invoke('terminal_ack', { id, bytes: total }).catch(() => {});
}

/**
 * Starts a terminal's shell, once however many views ask meanwhile.
 * @param {string} id
 * @param {{ cols: number, rows: number }} size
 * @returns {Promise<boolean>} It started.
 */
function open(id, size) {
  let starting = opening.get(id);
  if (!starting) {
    starting = start(id, size).finally(() => opening.delete(id));
    opening.set(id, starting);
  }
  return starting;
}

/**
 * @param {string} id
 * @param {{ cols: number, rows: number }} size
 * @returns {Promise<boolean>} It started.
 */
async function start(id, { cols, rows }) {
  const info = $terminals.get()[id];
  if (!info) return false;
  try {
    /** @type {TerminalOpened} */
    const opened = await ipc.invoke('terminal_open', { id, cwd: info.cwd, fallback: info.fallback, cols, rows });
    terminalStarted(id, opened, `${opened.shell} — ${folderLabel(opened.cwd, $sessions.get())}`);
    return true;
  } catch (err) {
    terminalFailed(id, String(err));
    return false;
  }
}

/**
 * Sends the input typed so far, unless a write is in flight (it sends the rest when done) or the
 * shell isn't running yet.
 * @param {string} id
 */
function flush(id) {
  const typed = input.get(id);
  if (!typed || typed.sending || !typed.pending.length || $terminals.get()[id]?.status !== 'running') return;
  const chunk = new Uint8Array(typed.pending.reduce((n, bytes) => n + bytes.length, 0));
  typed.pending.reduce((at, bytes) => (chunk.set(bytes, at), at + bytes.length), 0);
  typed.pending = [];
  typed.sending = true;
  ipc
    .invoke('terminal_write', chunk, { headers: { 'terminal-id': id } })
    .catch(() => {})
    .finally(() => {
      typed.sending = false;
      flush(id);
    });
}

/**
 * Input goes out one write at a time, so it reaches the shell in order; what's typed meanwhile
 * goes in the next one.
 * @param {string} id
 * @param {string | Uint8Array} data Typed text, or raw bytes.
 */
function write(id, data) {
  const typed = input.get(id) ?? { pending: [], sending: false };
  input.set(id, typed);
  typed.pending.push(typeof data === 'string' ? encoder.encode(data) : data);
  flush(id);
}

/**
 * Exit code 0 closes the tab, wherever it is; anything else keeps it, with Restart.
 * @param {string} id
 * @param {TerminalExit} exit
 */
function exited(id, exit) {
  const info = $terminals.get()[id];
  if (!info || info.status === 'exited') return;
  if (info.sessionId) terminalExited(id, exit);
  else if (exit.code === 0 && exit.signal === null) closeProjectTab(info.projectPath, tabs.terminalId(id));
  else terminalExited(id, exit);
}

/**
 * @param {string} id
 * @param {Route} route
 */
async function attach(id, route) {
  await previousClosed();
  // A session's CLI that didn't start has no terminal in the backend: its view shows why.
  if ($terminals.get()[id]?.sessionId && $terminals.get()[id]?.status === 'failed') return;
  if ($terminals.get()[id]?.status === 'starting' && !(await open(id, route.size))) return;
  flush(id);
  if (route.disposed || !$terminals.get()[id]) return;
  const { cols, rows } = route.size;
  if ($terminals.get()[id]?.status === 'running') await ipc.invoke('terminal_resize', { id, cols, rows }).catch(() => {});
  try {
    const output = ipc.channel((/** @type {ArrayBuffer} */ buffer) => {
      const bytes = new Uint8Array(buffer);
      if (route.disposed) {
        ack(id, bytes.length);
        return;
      }
      route.undrawn += bytes.length;
      route.sink.output(bytes, () => {
        if (route.disposed) return;
        route.undrawn -= bytes.length;
        ack(id, bytes.length);
      });
    });
    const events = ipc.channel((/** @type {{ kind: 'exit', code: number | null, signal: string | null }} */ { code, signal }) => {
      if (!route.disposed) route.sink.exit({ code, signal });
      exited(id, { code, signal });
    });
    await ipc.invoke('terminal_attach', { id, output, events });
  } catch (err) {
    // Closed meanwhile; anything else is the backend's to report.
    if ($terminals.get()[id]) terminalFailed(id, String(err));
  }
}

/**
 * Terminal tabs' shells: opens them in the right folder, streams them to their views, closes a
 * shell when its tab closes (one tab, Close Others / All, its project removed) and a tab when its
 * shell exits with code 0.
 */
export const terminals = Object.freeze({
  /**
   * Closes a terminal once its tab is gone from its project's tabs.
   * @returns {() => void} Stops following.
   */
  start() {
    previousClosed();
    const stops = [
      $projectTabs.listen((projects) => {
        const gone = Object.entries($terminals.get())
          .filter(([id, t]) => !t.sessionId && !projects[t.projectPath ?? '']?.paths.includes(tabs.terminalId(id)))
          .map(([id]) => id);
        if (gone.length) release(gone);
      }),
      // A session's CLI is closed by the backend (`session_close_cli`); only its stream is dropped here.
      $terminals.listen((all) => {
        for (const id of [...routes.keys(), ...input.keys()]) {
          if (!all[id]) forget(id);
        }
      }),
    ];
    return () => stops.forEach((stop) => stop());
  },

  /** New Terminal: in the active session's folder, the project, or home. */
  async newTerminal() {
    const project = $workspace.get()?.path ?? null;
    const home = project === null ? await ipc.homeDir() : '';
    openIn(newTerminalFolder({ activeFolder: $activeFolder.get(), project, home }));
  },

  /** Project Terminal: always in the project root folder, or home if no project. */
  async projectTerminal() {
    const project = $workspace.get()?.path ?? null;
    const home = project === null ? await ipc.homeDir() : '';
    openIn(projectTerminalFolder({ project, home }));
  },

  /**
   * Open in → Terminal: in the session's folder, among the shown project's tabs.
   * @param {Session} session
   */
  openInSession(session) {
    openIn(sessionTerminalFolder(session));
  },

  /**
   * Streams a terminal into a view, starting its shell at the view's size the first time.
   * @type {TerminalConnect}
   */
  connect(id, size, sink) {
    /** @type {Route} */
    const route = { sink, size, disposed: false, undrawn: 0 };
    routes.set(id, route);
    attach(id, route);
    return {
      write: (data) => write(id, data),
      resize: (cols, rows) => {
        route.size = { cols, rows };
        if ($terminals.get()[id]?.status === 'running') ipc.invoke('terminal_resize', { id, cols, rows }).catch(() => {});
      },
      dispose: () => {
        route.disposed = true;
        if (routes.get(id) === route) routes.delete(id);
        // A disposed screen never draws the rest.
        ack(id, route.undrawn, true);
        route.undrawn = 0;
      },
    };
  },

  /**
   * A fresh shell in an exited or failed terminal's tab, in the same folder, its output cleared.
   * @param {string} id
   */
  async restart(id) {
    const info = $terminals.get()[id];
    // A session's CLI starts again through its session (`sessions.restartCli()`).
    if (!info || info.sessionId || info.status === 'running' || info.status === 'starting') return;
    const route = routes.get(id);
    terminalRestarting(id);
    if (!route) return; // its view starts it when shown
    route.sink.reset();
    // A failed terminal was never attached; an exited one keeps its attachment across the restart.
    if (info.status === 'failed') attach(id, route);
    else if (await open(id, route.size)) flush(id);
  },

  /**
   * @param {string[]} ids
   * @returns {Promise<TerminalBusy[]>} Those running a program other than their shell.
   */
  busy(ids) {
    return ids.length ? ipc.invoke('terminal_busy', { ids }).catch(() => []) : Promise.resolve([]);
  },

  close,

  shellPaths,
});
