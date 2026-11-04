import { $folderTabs } from '../../stores/editor/editor.js';
import { $shownFolder, $workspaces } from '../../stores/workspaces/workspaces.js';
import {
  $folderTerminalPanels,
  $folderTerminalTabs,
  $terminalPanel,
  $terminalTabs,
  $terminals,
  $windowsBuild,
  closeTerminalTab,
  focusTerminal,
  forgetTerminal,
  openTerminal,
  removeProjectTerminals,
  setTerminalPanelOpen,
  terminalExited,
  terminalFailed,
  terminalRestarting,
  terminalStarted,
} from '../../stores/terminals/terminals.js';
import { $project } from '../../stores/project/project.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { tabs } from '../tabs/tabs.js';
import { folderLabel, newTerminalFolder, sessionTerminalFolder, shellPaths, terminalTab } from './rules.js';

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
 * @property {TerminalSink | null} sink `null` once disposed: the backend keeps the channel until the next attach, which mustn't keep the screen.
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
  openTerminal(cwd, fallback, folderLabel(cwd, $workspaces.get()));
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
    terminalStarted(id, opened, `${opened.shell} — ${folderLabel(opened.cwd, $workspaces.get())}`);
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
  else if (exit.code === 0 && exit.signal === null) closeTerminalTab(info.folder, id);
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
  // Disposed meanwhile: attaching would take the stream from a newer view.
  if (route.disposed) return;
  try {
    const output = ipc.channel((/** @type {ArrayBuffer} */ buffer) => {
      const bytes = new Uint8Array(buffer);
      if (!route.sink) {
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
      route.sink?.exit({ code, signal });
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
    ipc
      .invoke('windows_build')
      .then((build) => $windowsBuild.set(/** @type {number | null} */ (build)))
      .catch((err) => app.log('warn', `Reading the Windows build failed: ${err}`));
    // A terminal's tab is in its project's editor tabs or in its terminal panel's.
    const releaseGone = () => {
      const editor = $folderTabs.get();
      const panel = $folderTerminalTabs.get();
      const gone = Object.entries($terminals.get())
        .filter(([id, t]) => {
          const tab = tabs.terminalId(id);
          const root = t.folder ?? '';
          return !t.sessionId && !editor[root]?.paths.includes(tab) && !panel[root]?.paths.includes(tab);
        })
        .map(([id]) => id);
      if (gone.length) release(gone);
    };
    const stops = [
      $folderTabs.listen(releaseGone),
      $folderTerminalTabs.listen((panel) => {
        // A panel is never shown empty.
        for (const [root, state] of Object.entries($folderTerminalPanels.get())) {
          if (state?.open && !panel[root]?.paths.length) setTerminalPanelOpen(root, false);
        }
        releaseGone();
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

  /**
   * The nav rail's Terminal button: shows the panel with its terminals, or with a first one in the
   * shown folder; with the panel shown, focuses its active terminal.
   */
  async showPanel() {
    const { open } = $terminalPanel.get();
    const { paths, active } = $terminalTabs.get();
    if (open && active !== null) {
      focusTerminal(tabs.terminalOf(active) ?? '');
    } else if (paths.length) {
      setTerminalPanelOpen($shownFolder.get(), true);
      if (active !== null) focusTerminal(tabs.terminalOf(active) ?? '');
    } else {
      await terminals.newTerminal();
    }
  },

  /** Hides the shown folder's panel; its shells keep running. */
  hidePanel() {
    setTerminalPanelOpen($shownFolder.get(), false);
  },

  /** New Terminal (`+`, ⌃\`, the Terminal menu) in the panel, shown if hidden: in the shown folder, the project, or home. */
  async newTerminal() {
    const project = $project.get()?.path ?? null;
    const home = project === null ? await ipc.homeDir() : '';
    openIn(newTerminalFolder({ folder: $shownFolder.get(), project, home }));
  },

  /**
   * Open in → Terminal: in the session's folder, in the shown project's panel.
   * @param {Session} session
   */
  openInSession(session) {
    openIn(sessionTerminalFolder(session));
  },

  /**
   * Open in → Terminal of a workspace or Main: a terminal in its folder.
   * @param {string} path
   */
  openAt(path) {
    openIn({ cwd: path, fallback: path });
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
      clear: () => {
        ipc.invoke('terminal_clear', { id }).catch(() => {});
      },
      dispose: () => {
        route.disposed = true;
        route.sink = null;
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
    route.sink?.reset();
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

  /** @returns {Promise<string>} What a paste asked for from a terminal's menu or keys pastes. */
  readClipboard() {
    return ipc.readClipboard();
  },

  /**
   * Closes a folder's terminals, waiting for their shells to end, and forgets its panel: before its
   * workspace is deleted, so no shell keeps the folder busy (Windows refuses to remove a cwd) or
   * writes into it as it goes.
   * @param {string} folder
   */
  async closeFolder(folder) {
    const ids = Object.entries($terminals.get())
      .filter(([, t]) => t.folder === folder && !t.sessionId)
      .map(([id]) => id);
    // Forgotten before their tabs close, so the tab listener doesn't close them again.
    for (const id of ids) forgetTerminal(id);
    for (const id of ids) closeTerminalTab(folder, id);
    removeProjectTerminals(folder);
    if (!ids.length) return;
    try {
      await previousClosed();
      await close(ids);
    } catch (err) {
      app.reportError('Closing terminals failed', err);
    }
  },

  shellPaths,

  terminalTab,
});
