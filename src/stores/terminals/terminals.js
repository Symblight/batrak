import { atom, computed, map } from 'nanostores';
import { closeProjectTab } from '../editor/editor.js';
import { persistentMapStore } from '../persistent/persistent.js';
import { NO_PROJECT, NO_TABS, tabGroup } from '../tab-group/tab-group.js';
import { $workspace } from '../workspace/workspace.js';
import { terminalTabId } from '../tab-ids/tab-ids.js';

/** @typedef {import('../../hooks/terminals/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../hooks/terminals/types.js').TerminalOpened} TerminalOpened */
/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */

/** Every terminal tab's shell, by terminal id. In memory: shells don't outlive the page. */
export const $terminals = atom(/** @type {Readonly<Record<string, TerminalInfo>>} */ ({}));

/**
 * The terminal panel's tabs by project path: terminal tabs only, in memory (shells don't outlive the
 * page, so neither does a tab), written through `terminalGroup`.
 */
export const $projectTerminalTabs = map(/** @type {Record<string, EditorTabs | undefined>} */ ({}));

/** The shown project's terminal tabs; with no project, those opened with none. */
export const $terminalTabs = computed(
  [$projectTerminalTabs, $workspace],
  (projects, workspace) => projects[workspace?.path ?? NO_PROJECT] ?? NO_TABS,
);

/** The editor's tab rules, applied to the terminal group (a second group, not a second tab system). */
export const terminalGroup = tabGroup({
  $projects: $projectTerminalTabs,
  $tabs: $terminalTabs,
  shownKey: () => $workspace.get()?.path ?? NO_PROJECT,
});

/**
 * Whether each project's terminal panel is shown, by project path (`NO_PROJECT` for none). In memory,
 * like the shells; only a panel with terminals is ever open (the hook hides it with its last one).
 */
export const $projectTerminalPanels = map(/** @type {Record<string, { open: boolean } | undefined>} */ ({}));

/** The shown project's panel. */
export const $terminalPanel = computed([$projectTerminalPanels, $workspace], (panels, workspace) => panels[workspace?.path ?? NO_PROJECT] ?? { open: false });

/**
 * @param {string | null} root The project's path; `null`: no project.
 * @param {boolean} open
 */
export function setTerminalPanelOpen(root, open) {
  const key = root ?? NO_PROJECT;
  if (($projectTerminalPanels.get()[key]?.open ?? false) !== open) $projectTerminalPanels.setKey(key, { open });
}

/** Limits of the panel's height, in px. */
export const TERMINAL_PANEL_MIN_HEIGHT = 120;
export const TERMINAL_PANEL_MAX_HEIGHT = 800;

/** The panel's height by project path, one storage item per project; per window, like the tabs. Written only through `setKey()`. */
export const $projectTerminalPanelHeights = persistentMapStore('brama:layout:terminal-panel:', (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) ? clampHeight(raw) : null,
);

/** The shown project's panel height; `null` until it was resized (the token's default applies). */
export const $terminalPanelHeight = computed(
  [$projectTerminalPanelHeights, $workspace],
  (heights, workspace) => heights[workspace?.path ?? NO_PROJECT] ?? null,
);

/** @param {number} px */
function clampHeight(px) {
  return Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.round(px)));
}

/** @param {number} px The shown project's panel height; kept within the limits. */
export function setTerminalPanelHeight(px) {
  if (!Number.isFinite(px)) return;
  $projectTerminalPanelHeights.setKey($workspace.get()?.path ?? NO_PROJECT, clampHeight(px));
}

/** The shown project's panel goes back to the default height. */
export function clearTerminalPanelHeight() {
  const key = $workspace.get()?.path ?? NO_PROJECT;
  if (key in $projectTerminalPanelHeights.get()) $projectTerminalPanelHeights.setKey(key, undefined);
}

/** A request to focus a terminal's screen, until its view has. */
export const $terminalFocus = atom(/** @type {{ terminalId: string } | null} */ (null));

/** @param {string} terminalId */
export function focusTerminal(terminalId) {
  $terminalFocus.set({ terminalId });
}

/** @param {{ terminalId: string }} request The one the view answered; a newer request stays. */
export function terminalFocused(request) {
  if ($terminalFocus.get() === request) $terminalFocus.set(null);
}

/**
 * Forgets a project's terminal tabs, panel and height, e.g. when it is removed from the app.
 * @param {string} root Project path.
 */
export function removeProjectTerminals(root) {
  terminalGroup.forget(root);
  if (root in $projectTerminalPanels.get()) $projectTerminalPanels.setKey(root, undefined);
  if (root in $projectTerminalPanelHeights.get()) $projectTerminalPanelHeights.setKey(root, undefined);
}

/**
 * Closes a terminal's tab, among the editor's tabs or the panel's, of any project.
 * @param {string | null} projectPath
 * @param {string} id The terminal's.
 */
export function closeTerminalTab(projectPath, id) {
  closeProjectTab(projectPath, terminalTabId(id));
  terminalGroup.closeIn(projectPath, terminalTabId(id));
}

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
 * Adds a terminal and opens its tab (at the end of the strip, active) in the shown project's terminal
 * panel, showing the panel. Its shell starts when the tab is first shown.
 * @param {string} cwd
 * @param {string | null} fallback Where it starts when `cwd` doesn't exist.
 * @param {string} label The tab's title until it starts.
 * @returns {string} The terminal's id.
 */
export function openTerminal(cwd, fallback, label) {
  const id = addTerminal(cwd, fallback, label);
  terminalGroup.open(terminalTabId(id));
  setTerminalPanelOpen($workspace.get()?.path ?? null, true);
  return id;
}

/**
 * @param {string} cwd
 * @param {string | null} fallback
 * @param {string} label
 * @returns {string} The id of the terminal added to the shown project's.
 */
function addTerminal(cwd, fallback, label) {
  const id = crypto.randomUUID();
  const projectPath = $workspace.get()?.path ?? null;
  $terminals.set({
    ...$terminals.get(),
    [id]: { cwd, fallback, label, title: null, projectPath, status: 'starting', exit: null, error: null, login: null },
  });
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
 * Shows a sign-in's login, which the backend started, as a tab of the terminal panel of the project the
 * sign-in started in, showing the panel (once: it's shown again as it is, where it is).
 * @param {import('../../hooks/agents/types.js').LoginTab} tab
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
  const root = known ? known.projectPath : projectPath;
  terminalGroup.openIn(root, terminalTabId(terminalId));
  setTerminalPanelOpen(root, true);
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
