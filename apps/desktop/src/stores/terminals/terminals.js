import { atom, computed } from 'nanostores';
import { $folderTabs, closeFolderTab, moveTab, openFolderTab, openTab, parseTabs } from '../editor/editor.js';
import { isRecord, persistentMapStore } from '../persistent/persistent.js';
import { NO_PROJECT, NO_TABS, tabGroup } from '../tab-group/tab-group.js';
import { $shownFolder } from '../workspaces/workspaces.js';
import { $projectPath } from '../project/project.js';
import { terminalTabId } from '../tab-ids/tab-ids.js';

/** @typedef {import('../../hooks/terminals/types.js').TerminalExit} TerminalExit */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../hooks/terminals/types.js').TerminalOpened} TerminalOpened */
/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */

/**
 * What a terminal needs to start again in a new page: shells don't outlive one, their tabs do.
 * @typedef {Pick<TerminalInfo, 'cwd' | 'fallback' | 'label' | 'folder' | 'projectPath'>} SavedTerminal
 */

/**
 * @param {unknown} raw
 * @returns {SavedTerminal | null}
 */
export function parseSavedTerminal(raw) {
  if (!isRecord(raw) || typeof raw.cwd !== 'string' || typeof raw.label !== 'string') return null;
  const { cwd, fallback, label, folder, projectPath } = raw;
  const stringOrNull = (/** @type {unknown} */ value) => typeof value === 'string' || value === null;
  if (!stringOrNull(fallback) || !stringOrNull(folder) || !stringOrNull(projectPath)) return null;
  return /** @type {SavedTerminal} */ ({ cwd, fallback, label, folder, projectPath });
}

/** Terminals of terminal tabs, by id, one storage item each; per window, like the tabs. Written from `$terminals`. */
export const $savedTerminals = persistentMapStore('batrak:terminals:', parseSavedTerminal);

/**
 * @param {Readonly<Record<string, SavedTerminal | undefined>>} saved
 * @returns {Record<string, TerminalInfo>} Shells yet to start, each when its tab is first shown.
 */
export function restoredTerminals(saved) {
  /** @type {Record<string, TerminalInfo>} */
  const terminals = {};
  for (const [id, terminal] of Object.entries(saved)) {
    if (terminal) terminals[id] = { ...terminal, title: null, status: 'starting', exit: null, error: null, login: null };
  }
  return terminals;
}

/** Every terminal tab's shell, by terminal id. */
export const $terminals = atom(/** @type {Readonly<Record<string, TerminalInfo>>} */ (restoredTerminals($savedTerminals.get())));

// A session's CLI and a login belong to what started them, which starts them again.
$terminals.listen((terminals) => {
  const saved = $savedTerminals.get();
  for (const id of Object.keys(saved)) {
    if (!terminals[id]) $savedTerminals.setKey(id, undefined);
  }
  for (const [id, { cwd, fallback, label, folder, projectPath, sessionId, login }] of Object.entries(terminals)) {
    if (sessionId || login) continue;
    const terminal = { cwd, fallback, label, folder, projectPath };
    if (JSON.stringify(saved[id]) !== JSON.stringify(terminal)) $savedTerminals.setKey(id, terminal);
  }
});

/**
 * The terminal panel's tabs by folder (`$shownFolder`'s keys): terminal tabs only, one storage item
 * each, written through `terminalGroup`.
 */
export const $folderTerminalTabs = persistentMapStore('batrak:terminal-panel:tabs:', parseTabs);

/** The shown folder's key in the per-folder maps; `NO_PROJECT` with none shown. */
const shownKey = () => $shownFolder.get() ?? NO_PROJECT;

/** The shown folder's terminal tabs; with none, those opened with none. */
export const $terminalTabs = computed(
  [$folderTerminalTabs, $shownFolder],
  (folders, folder) => folders[folder ?? NO_PROJECT] ?? NO_TABS,
);

/** The editor's tab rules, applied to the terminal group (a second group, not a second tab system). */
export const terminalGroup = tabGroup({
  $folders: $folderTerminalTabs,
  $tabs: $terminalTabs,
  shownKey,
});

/**
 * Whether each folder's terminal panel is shown, by folder (`NO_PROJECT` for none), one storage item
 * each; only a panel with terminals is ever open (the hook hides it with its last one).
 */
export const $folderTerminalPanels = persistentMapStore('batrak:terminal-panel:open:', (raw) =>
  isRecord(raw) && typeof raw.open === 'boolean' ? { open: raw.open } : null,
);

/** The shown folder's panel. */
export const $terminalPanel = computed([$folderTerminalPanels, $shownFolder], (panels, folder) => panels[folder ?? NO_PROJECT] ?? { open: false });

/**
 * @param {string | null} folder `null`: none.
 * @param {boolean} open
 */
export function setTerminalPanelOpen(folder, open) {
  const key = folder ?? NO_PROJECT;
  if (($folderTerminalPanels.get()[key]?.open ?? false) !== open) $folderTerminalPanels.setKey(key, { open });
}

/** Limits of the panel's height, in px. */
export const TERMINAL_PANEL_MIN_HEIGHT = 120;
export const TERMINAL_PANEL_MAX_HEIGHT = 800;

/** The panel's height by folder, one storage item each; per window, like the tabs. Written only through `setKey()`. */
export const $folderTerminalPanelHeights = persistentMapStore('batrak:layout:terminal-panel:', (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) ? clampHeight(raw) : null,
);

/** The shown folder's panel height; `null` until it was resized (the token's default applies). */
export const $terminalPanelHeight = computed(
  [$folderTerminalPanelHeights, $shownFolder],
  (heights, folder) => heights[folder ?? NO_PROJECT] ?? null,
);

/** @param {number} px */
function clampHeight(px) {
  return Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.round(px)));
}

/** @param {number} px The shown folder's panel height; kept within the limits. */
export function setTerminalPanelHeight(px) {
  if (!Number.isFinite(px)) return;
  $folderTerminalPanelHeights.setKey(shownKey(), clampHeight(px));
}

/** The shown folder's panel goes back to the default height. */
export function clearTerminalPanelHeight() {
  const key = shownKey();
  if (key in $folderTerminalPanelHeights.get()) $folderTerminalPanelHeights.setKey(key, undefined);
}

/** The Windows build the app runs on, which xterm's reflow depends on; `null` elsewhere and until it's known. */
export const $windowsBuild = atom(/** @type {number | null} */ (null));

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
 * Forgets a folder's terminal tabs, panel and height, and a project's terminals in any of its
 * folders, e.g. when the project is removed or a workspace deleted; the hook then closes their shells.
 * @param {string} root The folder, or the project's path.
 */
export function removeProjectTerminals(root) {
  for (const [id, t] of Object.entries($terminals.get())) {
    if (!t.sessionId && t.projectPath === root && t.folder !== root) closeTerminalTab(t.folder, id);
  }
  terminalGroup.forget(root);
  if (root in $folderTerminalPanels.get()) $folderTerminalPanels.setKey(root, undefined);
  if (root in $folderTerminalPanelHeights.get()) $folderTerminalPanelHeights.setKey(root, undefined);
}

/**
 * Closes a terminal's tab, among the editor's tabs or the panel's, of any folder.
 * @param {string | null} folder
 * @param {string} id The terminal's.
 */
export function closeTerminalTab(folder, id) {
  closeFolderTab(folder, terminalTabId(id));
  terminalGroup.closeIn(folder, terminalTabId(id));
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
 * Adds a terminal and opens its tab (at the end of the strip, active) in the shown folder's terminal
 * panel, showing the panel. Its shell starts when the tab is first shown.
 * @param {string} cwd
 * @param {string | null} fallback Where it starts when `cwd` doesn't exist.
 * @param {string} label The tab's title until it starts.
 * @returns {string} The terminal's id.
 */
export function openTerminal(cwd, fallback, label) {
  const id = addTerminal(cwd, fallback, label);
  terminalGroup.open(terminalTabId(id));
  setTerminalPanelOpen($shownFolder.get(), true);
  focusTerminal(id);
  return id;
}

/**
 * @param {string} cwd
 * @param {string | null} fallback
 * @param {string} label
 * @returns {string} The id of the terminal added to the shown folder's.
 */
function addTerminal(cwd, fallback, label) {
  const id = crypto.randomUUID();
  const folder = $shownFolder.get();
  $terminals.set({
    ...$terminals.get(),
    [id]: { cwd, fallback, label, title: null, folder, projectPath: $projectPath.get(), status: 'starting', exit: null, error: null, login: null },
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
    [id]: { cwd, fallback: null, label, title: null, folder: null, projectPath: null, status: 'running', exit: null, error: null, login: null, sessionId },
  });
  focusTerminal(id);
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
 * Shows a sign-in's login, which the backend started, as a tab of the terminal panel of the folder
 * shown when the sign-in started, showing the panel (once: it's shown again as it is, where it is).
 * @param {import('../../hooks/agents/types.js').LoginTab} tab
 * @param {string | null} folder
 */
export function openLoginTerminal({ terminalId, title, commandLine }, folder) {
  const known = $terminals.get()[terminalId];
  if (!known) {
    $terminals.set({
      ...$terminals.get(),
      [terminalId]: { cwd: '', fallback: null, label: title, title: null, folder, projectPath: $projectPath.get(), status: 'running', exit: null, error: null, login: commandLine },
    });
  }
  const root = known ? known.folder : folder;
  focusTerminal(terminalId);
  // Moved to the editor's tabs: shown there.
  if ($folderTabs.get()[root ?? NO_PROJECT]?.paths.includes(terminalTabId(terminalId))) {
    openFolderTab(root, terminalTabId(terminalId));
    return;
  }
  terminalGroup.openIn(root, terminalTabId(terminalId));
  setTerminalPanelOpen(root, true);
}

/**
 * Moves a terminal of the shown folder from the panel to the editor's tabs, at an index, active and
 * unpinned. Its shell is never without a tab: it lands in the editor's before it leaves the panel's.
 * @param {string} terminalId
 * @param {number} index In the editor's tabs without it.
 */
export function moveTerminalToEditor(terminalId, index) {
  const tab = terminalTabId(terminalId);
  if (!$terminalTabs.get().paths.includes(tab)) return;
  openTab(tab);
  moveTab(tab, index);
  terminalGroup.close(tab);
  focusTerminal(terminalId);
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
