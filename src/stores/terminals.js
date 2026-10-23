import { atom } from 'nanostores';
import { openProjectTab, openTab } from './editor.js';
import { $workspace } from './workspace.js';
import { terminalTabId } from '../models/tab-ids.js';

/** @typedef {import('../models/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../models/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../models/types.js').TerminalOpened} TerminalOpened */

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
 * Shows a sign-in's login, which the backend started, as a terminal tab among the tabs of the
 * project the sign-in started in (once: it's shown again as it is, where it is).
 * @param {import('../models/types.js').LoginTab} tab
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
    .filter(([, t]) => t.projectPath === projectPath)
    .map(([id]) => id);
}
