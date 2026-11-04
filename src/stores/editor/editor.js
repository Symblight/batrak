import { atom, computed } from 'nanostores';
import { isRecord, persistentMapStore } from '../persistent/persistent.js';
import { $projectPath } from '../project/project.js';
import { $shownFolder, $workspaces, $workspacesProject } from '../workspaces/workspaces.js';
import { isUserAgentsFile } from '../agents/rules.js';
import { workspaceChangesTabId, workspaceOfTab, terminalOfTab } from '../tab-ids/tab-ids.js';
import { NO_PROJECT, NO_TABS, tabGroup, tabsOf } from '../tab-group/tab-group.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../hooks/settings/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../hooks/agents/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../hooks/tabs/types.js').TabKind} TabKind */
/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */

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
    (workspaceOfTab(id) !== null ? 'workspace-changes' : terminalOfTab(id) !== null ? 'terminal' : undefined);
  return view ? { kind: view, path: '' } : { kind: 'file', path: id };
}

/**
 * Whether a tab may be open in a folder: a file tab only inside it (the user's agents.json anywhere),
 * a workspace's changes while the workspace is the project's, any other view anywhere.
 * @param {string} id Tab id.
 * @param {string} folder Absolute; `NO_PROJECT` contains no file.
 * @param {readonly Workspace[] | null} workspaces The shown project's workspaces; `null` until they
 *   are listed, when a workspace's changes are kept (a write now must not drop them).
 */
function belongsTo(id, folder, workspaces) {
  const { kind, path } = parseTabId(id);
  if (kind === 'workspace-changes') return workspaces === null || workspaces.some((w) => w.id === workspaceOfTab(id));
  if (kind !== 'file' || isUserAgentsFile(path)) return true;
  return folder !== NO_PROJECT && path.startsWith(`${folder}/`);
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
 * Open tabs by folder (a project's, Main's, or a workspace's), one storage item each. Per window, like
 * the folder they belong to; two windows on one take turns. Only the shown folder's entry is shown
 * (`$editorTabs`); the others wait here, untouched, until it is shown again.
 */
export const $folderTabs = persistentMapStore(TABS_PREFIX, parseTabs);

/**
 * Tabs of the shown folder (`$shownFolder`), only files inside it; while none is shown, the tabs that
 * show no file (Settings).
 */
export const $editorTabs = computed(
  [$folderTabs, $shownFolder, $workspaces, $workspacesProject, $projectPath],
  (folders, shown, workspaces, listedFor, project) => {
    const folder = shown ?? NO_PROJECT;
    const tabs = folders[folder];
    if (!tabs) return NO_TABS;
    const own = listedFor !== null && listedFor === project ? workspaces : null;
    return tabs.paths.every((id) => belongsTo(id, folder, own))
      ? tabs
      : tabsOf(
          tabs.paths.filter((id) => belongsTo(id, folder, own)),
          tabs.active,
          tabs.pinned,
        );
  },
);

/**
 * Moves the tabs of a project's workspaces' files from the project's entry, where they were kept
 * before workspaces had tabs of their own, to each workspace's (after its own, its active tab kept).
 * Once: they're gone from the project's entry then.
 * @param {string | null} project
 * @param {readonly import('../../hooks/workspaces/types.js').Workspace[]} list Its workspaces.
 */
function moveWorkspaceTabs(project, list) {
  if (project === null) return;
  for (const { folder } of list) {
    const from = $folderTabs.get()[project];
    const moved = from?.paths.filter((id) => parseTabId(id).kind === 'file' && id.startsWith(`${folder}/`)) ?? [];
    if (!from || !moved.length) continue;
    const to = $folderTabs.get()[folder] ?? NO_TABS;
    const added = moved.filter((id) => !to.paths.includes(id));
    $folderTabs.setKey(
      folder,
      tabsOf([...to.paths, ...added], to.active ?? from.active, [...to.pinned, ...from.pinned.filter((id) => added.includes(id))]),
    );
    $folderTabs.setKey(project, tabsOf(from.paths.filter((id) => !moved.includes(id)), from.active, from.pinned));
  }
}

$workspacesProject.subscribe((project) => moveWorkspaceTabs(project, $workspaces.get()));
$workspaces.listen((list) => moveWorkspaceTabs($workspacesProject.get(), list));

const group = tabGroup({
  $folders: $folderTabs,
  $tabs: $editorTabs,
  shownKey: () => $shownFolder.get() ?? NO_PROJECT,
});

export const {
  /** Opens a tab (appended to the strip) or switches to it; `path` is a file's absolute path, or a view's id. */
  open: openTab,
  /** Closes a tab, activating a neighbour if it was the active one. */
  close: closeTab,
  /** Opens a tab, active, among a folder's tabs, shown or not (`null`: no project). */
  openIn: openFolderTab,
  /** Closes a tab of any folder, shown or not. */
  closeIn: closeFolderTab,
  closeOthers: closeOtherTabs,
  closeToRight: closeTabsToRight,
  closeAll: closeAllTabs,
  move: moveTab,
  setPinned: setTabPinned,
  activate: activateTab,
  /** Forgets the tabs of a folder, e.g. when its project is removed or its workspace deleted. */
  forget: removeFolderTabs,
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
 * Opens the tab with a workspace's changes since its base, or switches to it; its project must be active.
 * @param {string} workspaceId
 */
export function openWorkspaceChanges(workspaceId) {
  openTab(workspaceChangesTabId(workspaceId));
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
