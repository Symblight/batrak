import { computed } from 'nanostores';
import { isRecord, persistentStore } from './persistent.js';
import { $workspace } from './workspace.js';

/** @typedef {import('../models/types.js').EditorTabs} EditorTabs */

/**
 * @param {string} path Absolute.
 * @param {string | null} root Absolute folder; `null` contains nothing.
 */
function isInside(path, root) {
  return root !== null && path.startsWith(`${root}/`);
}

/**
 * @param {string[]} paths
 * @param {string | null} active
 * @returns {EditorTabs} `active` kept if still among `paths`, else the first tab.
 */
function tabsOf(paths, active) {
  return { paths, active: active !== null && paths.includes(active) ? active : (paths[0] ?? null) };
}

/** @type {EditorTabs} */
const NO_TABS = { paths: [], active: null };

/**
 * Open tabs by project path. Per window, like the folder they belong to. Only the active project's
 * entry is shown (`$editorTabs`); the others wait here, untouched, until their project is activated.
 */
export const $projectTabs = persistentStore('brama:editor:tabs', /** @type {Record<string, EditorTabs>} */ ({}), {
  parse: (raw) => {
    if (!isRecord(raw)) return null;
    /** @type {Record<string, EditorTabs>} */
    const projects = {};
    for (const [root, value] of Object.entries(raw)) {
      if (!isRecord(value) || !Array.isArray(value.paths)) continue;
      const paths = [...new Set(value.paths)].filter((path) => typeof path === 'string' && isInside(path, root));
      projects[root] = tabsOf(paths, typeof value.active === 'string' ? value.active : null);
    }
    return projects;
  },
  listen: false,
});

/** Tabs of the active project (`$workspace`); none while no project is open. */
export const $editorTabs = computed(
  [$projectTabs, $workspace],
  (projects, workspace) => (workspace && projects[workspace.path]) || NO_TABS,
);

/** @param {EditorTabs} tabs Replaces the active project's tabs; no-op without one. */
function setTabs(tabs) {
  const root = $workspace.get()?.path;
  if (root) $projectTabs.set({ ...$projectTabs.get(), [root]: tabs });
}

/**
 * Forgets the tabs of a project, e.g. when it is removed from the app.
 * @param {string} root Project path.
 */
export function removeProjectTabs(root) {
  const { [root]: _gone, ...rest } = $projectTabs.get();
  if (_gone) $projectTabs.set(rest);
}

/** Notifies only when the active file changes, not when other tabs open or close. */
export const $activePath = computed($editorTabs, (tabs) => tabs.active);

/**
 * Opens a file in a tab (appended to the strip) or switches to its tab.
 * @param {string} path Absolute.
 */
export function openTab(path) {
  const { paths, active } = $editorTabs.get();
  if (paths.includes(path)) {
    if (active !== path) setTabs({ paths, active: path });
  } else {
    setTabs({ paths: [...paths, path], active: path });
  }
}

/**
 * Closes a tab, activating a neighbour if it was the active one.
 * @param {string} path
 */
export function closeTab(path) {
  const { paths, active } = $editorTabs.get();
  const index = paths.indexOf(path);
  if (index === -1) return;
  const rest = paths.filter((p) => p !== path);
  setTabs({ paths: rest, active: active === path ? (rest[Math.min(index, rest.length - 1)] ?? null) : active });
}

/** @param {string} path An open tab. */
export function activateTab(path) {
  const tabs = $editorTabs.get();
  if (tabs.active !== path && tabs.paths.includes(path)) setTabs({ ...tabs, active: path });
}
