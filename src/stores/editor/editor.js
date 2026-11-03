import { atom, computed } from 'nanostores';
import { isRecord, persistentMapStore } from '../persistent/persistent.js';
import { $sessionsLoaded, $worktrees } from '../sessions/sessions.js';
import { $project } from '../project/project.js';
import { isUserAgentsFile } from '../agents/rules.js';
import { sessionChangesTabId, sessionOfTab, terminalOfTab } from '../tab-ids/tab-ids.js';
import { NO_PROJECT, NO_TABS, tabGroup, tabsOf } from '../tab-group/tab-group.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../hooks/settings/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../hooks/agents/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../hooks/tabs/types.js').TabKind} TabKind */
/** @typedef {import('../../hooks/sessions/types.js').WorktreeFolder} WorktreeFolder */

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
      const project = JSON.parse(localStorage.getItem('brama:project') ?? localStorage.getItem('brama:workspace') ?? 'null');
      if (isRecord(project) && typeof project.path === 'string') entries = [[project.path, raw]];
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
 * Tabs of the active project (`$project`), only files inside it or its worktree sessions' folders;
 * while no project is open, the tabs that show no file (Settings).
 */
export const $editorTabs = computed(
  [$projectTabs, $project, $worktrees, $sessionsLoaded],
  (projects, project, worktrees, loaded) => {
    const root = project?.path ?? NO_PROJECT;
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

const group = tabGroup({
  $projects: $projectTabs,
  $tabs: $editorTabs,
  shownKey: () => $project.get()?.path ?? NO_PROJECT,
});

export const {
  /** Opens a tab (appended to the strip) or switches to it; `path` is a file's absolute path, or a view's id. */
  open: openTab,
  /** Closes a tab, activating a neighbour if it was the active one. */
  close: closeTab,
  /** Opens a tab, active, among a project's tabs, shown or not (`null`: no project). */
  openIn: openProjectTab,
  /** Closes a tab of any project, shown or not. */
  closeIn: closeProjectTab,
  closeOthers: closeOtherTabs,
  closeToRight: closeTabsToRight,
  closeAll: closeAllTabs,
  move: moveTab,
  setPinned: setTabPinned,
  activate: activateTab,
  /** Forgets the tabs of a project, e.g. when it is removed from the app. */
  forget: removeProjectTabs,
} = group;

/** Id of the active tab; notifies only when it changes, not when other tabs open or close. */
export const $activePath = computed($editorTabs, (tabs) => tabs.active);

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
