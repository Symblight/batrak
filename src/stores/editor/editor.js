import { atom, computed } from 'nanostores';
import { isRecord, persistentMapStore } from '../persistent/persistent.js';
import { $sessionsLoaded, $worktrees } from '../sessions/sessions.js';
import { $workspace } from '../workspace/workspace.js';
import { isUserAgentsFile } from '../../models/agents-file/agents-file.js';
import { sessionChangesTabId, sessionOfTab, terminalOfTab } from '../tab-ids/tab-ids.js';

/** @typedef {import('../../models/types/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../models/types/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../models/types/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../models/types/types.js').TabKind} TabKind */
/** @typedef {import('../../models/types/types.js').WorktreeFolder} WorktreeFolder */

/** Id of the Settings tab. */
export const SETTINGS_TAB_ID = 'view:settings';
/** Id of the Agents tab: installed agents, their switches and updates, and the registry's. */
export const AGENTS_TAB_ID = 'view:agents';
/** Id of the Changes tab: every changed file, each expanding into its diff. */
export const CHANGES_TAB_ID = 'view:changes';
/** Id of the Browser tab. */
export const BROWSER_TAB_ID = 'view:browser';

/** @type {Map<string, Exclude<TabKind, 'file'>>} View tabs by id; any other id is a file's path. */
const VIEW_TABS = new Map([
  [SETTINGS_TAB_ID, 'settings'],
  [AGENTS_TAB_ID, 'agents'],
  [CHANGES_TAB_ID, 'changes'],
  [BROWSER_TAB_ID, 'browser'],
]);

/** Key in `$projectTabs` of the tabs open while no project is: only tabs that show no file. */
const NO_PROJECT = '';

/**
 * @param {string} id A tab id from `$editorTabs`.
 * @returns {{ kind: TabKind, path: string }} What the tab shows, and its file (absolute; `''` for a
 *   view, like Settings).
 */
export function parseTabId(id) {
  const view =
    VIEW_TABS.get(id) ??
    (sessionOfTab(id) !== null ? 'session-changes' : terminalOfTab(id) !== null ? 'terminal' : undefined);
  return view ? { kind: view, path: '' } : { kind: 'file', path: id };
}

/**
 * Whether a tab may be open in a project: a file tab only inside its folder or one of its worktree
 * sessions' (the user's agents.json anywhere), a session's changes while it's one of them, any other
 * view anywhere.
 * @param {string} id Tab id.
 * @param {string} root Absolute project folder; `NO_PROJECT` contains no file.
 * @param {readonly WorktreeFolder[] | null} worktrees The project's worktree sessions; `null` until
 *   the sessions are listed, when a tab that may be one's is kept (a write now must not drop it).
 */
function belongsTo(id, root, worktrees) {
  const { kind, path } = parseTabId(id);
  if (kind === 'session-changes') return worktrees === null || worktrees.some((w) => w.sessionId === sessionOfTab(id));
  if (kind !== 'file' || isUserAgentsFile(path)) return true;
  if (root === NO_PROJECT) return false;
  if (worktrees === null) return true;
  return [root, ...worktrees.map((w) => w.folder)].some((folder) => path.startsWith(`${folder}/`));
}

/**
 * @param {string[]} paths
 * @param {string | null} active
 * @param {string[]} [pinned]
 * @returns {EditorTabs} `active` kept if still among `paths`, else the first tab; pinned tabs that are
 *   open, moved to the front.
 */
function tabsOf(paths, active, pinned = []) {
  const pins = pinned.filter((id) => paths.includes(id));
  return {
    paths: pins.length ? [...pins, ...paths.filter((id) => !pins.includes(id))] : paths,
    active: active !== null && paths.includes(active) ? active : (paths[0] ?? null),
    pinned: pins,
  };
}

/** @type {EditorTabs} */
const NO_TABS = { paths: [], active: null, pinned: [] };

/** The Terminal tab before terminals had ids. */
const OLD_TERMINAL_TAB_ID = 'view:terminal';

/**
 * Stored tabs; terminal tabs are dropped, since their shells didn't outlive the page.
 * @param {unknown} raw
 * @returns {EditorTabs | null}
 */
export function parseTabs(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.paths)) return null;
  const paths = [...new Set(raw.paths)].filter(
    (path) => typeof path === 'string' && path !== OLD_TERMINAL_TAB_ID && terminalOfTab(path) === null,
  );
  const pinned = Array.isArray(raw.pinned) ? raw.pinned.filter((id) => typeof id === 'string') : [];
  return tabsOf(paths, typeof raw.active === 'string' ? raw.active : null, pinned);
}

const TABS_PREFIX = 'brama:editor:tabs:';

/**
 * Moves tabs saved in one `brama:editor:tabs` item to an item per project. That item held either all
 * projects' tabs by path (which windows overwrote wholesale) or, before projects, the open folder's
 * `EditorTabs`.
 */
function migrateLegacyTabs() {
  const legacy = localStorage.getItem('brama:editor:tabs');
  if (legacy === null) return;
  /** @type {[string, unknown][]} */
  let entries = [];
  try {
    const raw = JSON.parse(legacy);
    if (parseTabs(raw)) {
      const workspace = JSON.parse(localStorage.getItem('brama:workspace') ?? 'null');
      if (isRecord(workspace) && typeof workspace.path === 'string') entries = [[workspace.path, raw]];
    } else if (isRecord(raw)) {
      entries = Object.entries(raw);
    }
  } catch {
    // Unparsable: nothing to keep.
  }
  for (const [root, value] of entries) {
    if (parseTabs(value) && localStorage.getItem(TABS_PREFIX + root) === null) {
      localStorage.setItem(TABS_PREFIX + root, JSON.stringify(value));
    }
  }
  localStorage.removeItem('brama:editor:tabs');
}

try {
  migrateLegacyTabs();
} catch {
  // Storage unavailable (private mode): there is nothing saved to move.
}

/**
 * Open tabs by project path, one storage item per project. Per window, like the folder they belong
 * to; two windows on one project take turns. Only the active project's entry is shown
 * (`$editorTabs`); the others wait here, untouched, until their project is activated.
 */
export const $projectTabs = persistentMapStore(TABS_PREFIX, parseTabs);

/**
 * Tabs of the active project (`$workspace`), only files inside it or its worktree sessions' folders;
 * while no project is open, the tabs that show no file (Settings).
 */
export const $editorTabs = computed(
  [$projectTabs, $workspace, $worktrees, $sessionsLoaded],
  (projects, workspace, worktrees, loaded) => {
    const root = workspace?.path ?? NO_PROJECT;
    const tabs = projects[root];
    if (!tabs) return NO_TABS;
    const own = loaded ? worktrees.filter((w) => w.projectId === root) : null;
    return tabs.paths.every((id) => belongsTo(id, root, own))
      ? tabs
      : tabsOf(
          tabs.paths.filter((id) => belongsTo(id, root, own)),
          tabs.active,
          tabs.pinned,
        );
  },
);

/** @param {EditorTabs} tabs Replaces the tabs of the active project, or of no project. */
function setTabs(tabs) {
  $projectTabs.setKey($workspace.get()?.path ?? NO_PROJECT, tabs);
}

/**
 * Forgets the tabs of a project, e.g. when it is removed from the app.
 * @param {string} root Project path.
 */
export function removeProjectTabs(root) {
  // Through `setKey`: `set()` would rewrite every project's item from this window's copy.
  if (root in $projectTabs.get()) $projectTabs.setKey(root, undefined);
}

/** Id of the active tab; notifies only when it changes, not when other tabs open or close. */
export const $activePath = computed($editorTabs, (tabs) => tabs.active);

/**
 * Opens a tab (appended to the strip) or switches to it.
 * @param {string} path Tab id: a file's absolute path, or a view's id.
 */
export function openTab(path) {
  const tabs = $editorTabs.get();
  if (tabs.paths.includes(path)) {
    if (tabs.active !== path) setTabs({ ...tabs, active: path });
  } else {
    setTabs({ ...tabs, paths: [...tabs.paths, path], active: path });
  }
}

/**
 * @param {EditorTabs} tabs
 * @param {string} path Tab id.
 * @returns {EditorTabs | null} `tabs` without it, a neighbour active if it was; `null` when it isn't open.
 */
function without({ paths, active, pinned }, path) {
  const index = paths.indexOf(path);
  if (index === -1) return null;
  const rest = paths.filter((p) => p !== path);
  return {
    paths: rest,
    active: active === path ? (rest[Math.min(index, rest.length - 1)] ?? null) : active,
    pinned: pinned.filter((p) => p !== path),
  };
}

/**
 * Closes a tab, activating a neighbour if it was the active one.
 * @param {string} path Tab id.
 */
export function closeTab(path) {
  const rest = without($editorTabs.get(), path);
  if (rest) setTabs(rest);
}

/**
 * Opens a tab, active, among a project's tabs, shown or not.
 * @param {string | null} root The project's path; `null`: no project.
 * @param {string} path Tab id.
 */
export function openProjectTab(root, path) {
  const key = root ?? NO_PROJECT;
  if (key === ($workspace.get()?.path ?? NO_PROJECT)) {
    openTab(path);
    return;
  }
  const tabs = $projectTabs.get()[key] ?? NO_TABS;
  $projectTabs.setKey(key, { ...tabs, paths: tabs.paths.includes(path) ? tabs.paths : [...tabs.paths, path], active: path });
}

/**
 * Closes a tab of any project, shown or not, e.g. a terminal whose shell exited.
 * @param {string | null} root Project path; `null` for the tabs open with no project.
 * @param {string} path Tab id.
 */
export function closeProjectTab(root, path) {
  const key = root ?? NO_PROJECT;
  if (key === ($workspace.get()?.path ?? NO_PROJECT)) {
    closeTab(path);
    return;
  }
  const tabs = $projectTabs.get()[key];
  const rest = tabs && without(tabs, path);
  if (rest) $projectTabs.setKey(key, rest);
}

/**
 * Closes every tab but `path` and the pinned ones, and activates `path`.
 * @param {string} path Tab id.
 */
export function closeOtherTabs(path) {
  const { paths, pinned } = $editorTabs.get();
  if (!paths.includes(path)) return;
  setTabs({ paths: paths.filter((p) => p === path || pinned.includes(p)), active: path, pinned });
}

/**
 * Closes the tabs after `path` but the pinned ones; activates `path` if the active tab was among them.
 * @param {string} path Tab id.
 */
export function closeTabsToRight(path) {
  const { paths, active, pinned } = $editorTabs.get();
  const index = paths.indexOf(path);
  if (index === -1) return;
  const kept = paths.filter((p, i) => i <= index || pinned.includes(p));
  setTabs({ paths: kept, active: active !== null && kept.includes(active) ? active : path, pinned });
}

/** Closes every tab but the pinned ones. */
export function closeAllTabs() {
  const { active, pinned } = $editorTabs.get();
  setTabs(tabsOf(pinned, active, pinned));
}

/**
 * Moves a tab within the strip; pinned tabs stay in front of the others.
 * @param {string} path Tab id.
 * @param {number} index In the strip without it.
 */
export function moveTab(path, index) {
  const { paths, active, pinned } = $editorTabs.get();
  if (!paths.includes(path)) return;
  const next = paths.filter((p) => p !== path);
  next.splice(index, 0, path);
  setTabs(
    tabsOf(
      next,
      active,
      next.filter((p) => pinned.includes(p)),
    ),
  );
}

/**
 * Pins a tab (moved to the end of the pinned ones) or unpins it (moved just after them).
 * @param {string} path Tab id.
 * @param {boolean} pin
 */
export function setTabPinned(path, pin) {
  const { paths, active, pinned } = $editorTabs.get();
  if (!paths.includes(path) || pinned.includes(path) === pin) return;
  const pins = pin ? [...pinned, path] : pinned.filter((p) => p !== path);
  const rest = paths.filter((p) => p !== path && !pins.includes(p));
  setTabs({ paths: [...pins, ...(pin ? [] : [path]), ...rest], active, pinned: pins });
}

/**
 * Opens the Settings tab, or switches to it.
 * @param {SettingsReveal | null} [reveal] A section to scroll to.
 */
export function openSettings(reveal = null) {
  if (reveal) $settingsReveal.set(reveal);
  openTab(SETTINGS_TAB_ID);
}

/** A section the Settings tab is to scroll to (and what to open there), until it has. */
export const $settingsReveal = atom(/** @type {SettingsReveal | null} */ (null));

/**
 * The Settings tab showed `reveal`; a newer request stays.
 * @param {SettingsReveal} reveal
 */
export function settingsRevealed(reveal) {
  if ($settingsReveal.get() === reveal) $settingsReveal.set(null);
}

/**
 * Opens the Agents tab, or switches to it.
 * @param {AgentsReveal | null} [reveal] Its add form, or an agent's row, to show.
 */
export function openAgents(reveal = null) {
  if (reveal) $agentsReveal.set(reveal);
  openTab(AGENTS_TAB_ID);
}

/** What the Agents tab is to show, until it has. */
export const $agentsReveal = atom(/** @type {AgentsReveal | null} */ (null));

/**
 * The Agents tab showed `reveal`; a newer request stays.
 * @param {AgentsReveal} reveal
 */
export function agentsRevealed(reveal) {
  if ($agentsReveal.get() === reveal) $agentsReveal.set(null);
}

/** Opens the Changes tab, or switches to it. */
export function openChanges() {
  openTab(CHANGES_TAB_ID);
}

/**
 * Opens the tab with a worktree session's changes, or switches to it; its project must be active.
 * @param {string} sessionId
 */
export function openSessionChanges(sessionId) {
  openTab(sessionChangesTabId(sessionId));
}

/** Opens the Browser tab, or switches to it. */
export function openBrowser() {
  openTab(BROWSER_TAB_ID);
}

/** @param {string} path Id of an open tab. */
export function activateTab(path) {
  const tabs = $editorTabs.get();
  if (tabs.active !== path && tabs.paths.includes(path)) setTabs({ ...tabs, active: path });
}

/**
 * Languages picked for files in the footer's language menu, by absolute path; a file without one is
 * highlighted by its extension. In memory: a pick lasts until the app reloads.
 * @type {import('nanostores').WritableAtom<Readonly<Record<string, string>>>}
 */
export const $fileLanguages = atom({});

/**
 * @param {string} path Absolute.
 * @param {string} language A language name; `''` goes back to the one its extension picks.
 */
export function setFileLanguage(path, language) {
  const { [path]: _, ...rest } = $fileLanguages.get();
  $fileLanguages.set(language ? { ...rest, [path]: language } : rest);
}
