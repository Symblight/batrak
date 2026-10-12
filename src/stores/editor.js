import { computed } from 'nanostores';
import { isRecord, persistentMapStore } from './persistent.js';
import { $workspace } from './workspace.js';

/** @typedef {import('../models/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../models/types.js').TabKind} TabKind */

/** Id of the Settings tab. */
export const SETTINGS_TAB_ID = 'view:settings';
/** Id of the Changes tab: every changed file, each expanding into its diff. */
export const CHANGES_TAB_ID = 'view:changes';

/** Key in `$projectTabs` of the tabs open while no project is: only tabs that show no file. */
const NO_PROJECT = '';

/**
 * @param {string} id A tab id from `$editorTabs`.
 * @returns {{ kind: TabKind, path: string }} What the tab shows, and its file (absolute; `''` for a
 *   view, like Settings).
 */
export function parseTabId(id) {
  if (id === SETTINGS_TAB_ID) return { kind: 'settings', path: '' };
  if (id === CHANGES_TAB_ID) return { kind: 'changes', path: '' };
  return { kind: 'file', path: id };
}

/**
 * Whether a tab may be open in a project: a file tab only inside its folder, a view anywhere.
 * @param {string} id Tab id.
 * @param {string} root Absolute project folder; `NO_PROJECT` contains no file.
 */
function belongsTo(id, root) {
  const { kind, path } = parseTabId(id);
  if (kind !== 'file') return true;
  return root !== NO_PROJECT && path.startsWith(`${root}/`);
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

/**
 * @param {unknown} raw
 * @returns {EditorTabs | null}
 */
function parseTabs(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.paths)) return null;
  const paths = [...new Set(raw.paths)].filter((path) => typeof path === 'string');
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
 * Tabs of the active project (`$workspace`), only files inside it; while no project is open, the
 * tabs that show no file (Settings).
 */
export const $editorTabs = computed([$projectTabs, $workspace], (projects, workspace) => {
  const root = workspace?.path ?? NO_PROJECT;
  const tabs = projects[root];
  if (!tabs) return NO_TABS;
  return tabs.paths.every((id) => belongsTo(id, root))
    ? tabs
    : tabsOf(
        tabs.paths.filter((id) => belongsTo(id, root)),
        tabs.active,
        tabs.pinned,
      );
});

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
 * Closes a tab, activating a neighbour if it was the active one.
 * @param {string} path Tab id.
 */
export function closeTab(path) {
  const { paths, active, pinned } = $editorTabs.get();
  const index = paths.indexOf(path);
  if (index === -1) return;
  const rest = paths.filter((p) => p !== path);
  setTabs({
    paths: rest,
    active: active === path ? (rest[Math.min(index, rest.length - 1)] ?? null) : active,
    pinned: pinned.filter((p) => p !== path),
  });
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

/** Opens the Settings tab, or switches to it. */
export function openSettings() {
  openTab(SETTINGS_TAB_ID);
}

/** Opens the Changes tab, or switches to it. */
export function openChanges() {
  openTab(CHANGES_TAB_ID);
}

/** @param {string} path Id of an open tab. */
export function activateTab(path) {
  const tabs = $editorTabs.get();
  if (tabs.active !== path && tabs.paths.includes(path)) setTabs({ ...tabs, active: path });
}
