import { atom, computed } from 'nanostores';
import { openProjectTab, openTab } from '../editor/editor.js';
import { $workspace } from '../workspace/workspace.js';
import { terminalTabId } from '../tab-ids/tab-ids.js';

/** @typedef {import('../../models/types/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../models/types/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../models/types/types.js').TerminalOpened} TerminalOpened */

/** Every terminal tab's shell, by terminal id. In memory: shells don't outlive the page. */
export const $terminals = atom(/** @type {Readonly<Record<string, TerminalInfo>>} */ ({}));

/**
 * @param {string} id
 * @param {Partial<TerminalInfo>} patch
 */
function patch(id, patch) {
  const terminals = $terminals.get();
  const terminal = terminals[id];
  if (terminal) $terminals.set({ ...terminals, [id]: { ...terminal, ...patch } });
}

/**
 * Adds a terminal and opens its tab (at the end of the strip, active) in the shown project. Its
 * shell starts when the tab is first shown.
 * @param {string} cwd
 * @param {string | null} fallback Where it starts when `cwd` doesn't exist.
 * @param {string} label The tab's title until it starts.
 * @returns {string} The terminal's id.
 */
export function openTerminal(cwd, fallback, label) {
  const id = crypto.randomUUID();
  const projectPath = $workspace.get()?.path ?? null;
  $terminals.set({
    ...$terminals.get(),
    [id]: { cwd, fallback, label, title: null, projectPath, status: 'starting', exit: null, error: null, login: null },
  });
  openTab(terminalTabId(id));
  return id;
}

/**
 * Adds a session's CLI, which the backend started (`session_open_cli`): shown in the agent column in
 * place of the chat, never as a tab.
 * @param {string} id The terminal's.
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} label
 */
export function addSessionTerminal(id, sessionId, cwd, label) {
  $terminals.set({
    ...$terminals.get(),
    [id]: { cwd, fallback: null, label, title: null, projectPath: null, status: 'running', exit: null, error: null, login: null, sessionId },
  });
}

/** Sessions whose CLI is starting (`session_open_cli` asked, no answer yet). */
export const $cliStarting = atom(/** @type {readonly string[]} */ ([]));

/**
 * @param {string} sessionId
 * @param {boolean} starting
 */
export function setCliStarting(sessionId, starting) {
  const others = $cliStarting.get().filter((id) => id !== sessionId);
  $cliStarting.set(starting ? [...others, sessionId] : others);
}

/** Each session's CLI, by session id: its terminal's id. */
export const $sessionTerminals = computed($terminals, (terminals) =>
  /** @type {Readonly<Record<string, string>>} */ (
    Object.fromEntries(
      Object.entries(terminals)
        .filter(([, t]) => typeof t.sessionId === 'string')
        .map(([id, t]) => [/** @type {string} */ (t.sessionId), id]),
    )
  ),
);

/**
 * @param {string} sessionId
 * @returns {string | null} The terminal of the session's CLI.
 */
export function sessionTerminalOf(sessionId) {
  return $sessionTerminals.get()[sessionId] ?? null;
}

/**
 * Shows a sign-in's login, which the backend started, as a terminal tab among the tabs of the
 * project the sign-in started in (once: it's shown again as it is, where it is).
 * @param {import('../../models/types/types.js').LoginTab} tab
 * @param {string | null} projectPath
 */
export function openLoginTerminal({ terminalId, title, commandLine }, projectPath) {
  const known = $terminals.get()[terminalId];
  if (!known) {
    $terminals.set({
      ...$terminals.get(),
      [terminalId]: { cwd: '', fallback: null, label: title, title: null, projectPath, status: 'running', exit: null, error: null, login: commandLine },
    });
  }
  openProjectTab(known ? known.projectPath : projectPath, terminalTabId(terminalId));
}

/**
 * @param {string} id
 * @param {TerminalOpened} opened
 * @param {string} label
 */
export function terminalStarted(id, opened, label) {
  patch(id, { status: 'running', cwd: opened.cwd, label, exit: null, error: null });
}

/**
 * A fresh shell is starting in place of an exited or failed one.
 * @param {string} id
 */
export function terminalRestarting(id) {
  patch(id, { status: 'starting', title: null, exit: null, error: null });
}

/**
 * @param {string} id
 * @param {string} error
 */
export function terminalFailed(id, error) {
  patch(id, { status: 'failed', error });
}

/**
 * @param {string} id
 * @param {TerminalExit} exit
 */
export function terminalExited(id, exit) {
  patch(id, { status: 'exited', exit });
}

/**
 * @param {string} id
 * @param {string | null} title What the shell set; `null` or `''` goes back to the label.
 */
export function setTerminalTitle(id, title) {
  patch(id, { title: title || null });
}

/** @param {string} id */
export function forgetTerminal(id) {
  const { [id]: _, ...rest } = $terminals.get();
  $terminals.set(rest);
}

/**
 * @param {string | null} projectPath
 * @returns {string[]} The terminals whose tabs that project holds.
 */
export function terminalsOfProject(projectPath) {
  return Object.entries($terminals.get())
    .filter(([, t]) => t.projectPath === projectPath && !t.sessionId)
    .map(([id]) => id);
}
