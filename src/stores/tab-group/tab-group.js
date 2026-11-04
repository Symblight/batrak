/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */

/** Key in a group's per-folder map of the tabs open while no project is. */
export const NO_PROJECT = '';

/** @type {EditorTabs} */
export const NO_TABS = { paths: [], active: null, pinned: [] };

/**
 * @param {string[]} paths
 * @param {string | null} active
 * @param {string[]} [pinned]
 * @returns {EditorTabs} `active` kept if still among `paths`, else the first tab; pinned tabs that are
 *   open, moved to the front.
 */
export function tabsOf(paths, active, pinned = []) {
  const pins = pinned.filter((id) => paths.includes(id));
  return {
    paths: pins.length ? [...pins, ...paths.filter((id) => !pins.includes(id))] : paths,
    active: active !== null && paths.includes(active) ? active : (paths[0] ?? null),
    pinned: pins,
  };
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
 * A group of tabs per folder and the rules that open, close, move and pin them: the editor's
 * group, or the terminal panel's. The group's stores belong to the caller.
 * @param {Object} config
 * @param {import('nanostores').MapStore<Record<string, EditorTabs | undefined>>} config.$folders The
 *   tabs by folder (`NO_PROJECT` for none); written only through `setKey()`.
 * @param {{ get: () => EditorTabs }} config.$tabs The shown folder's tabs, as the group presents them.
 * @param {() => string} config.shownKey The shown folder's key in `$folders`.
 */
export function tabGroup({ $folders, $tabs, shownKey }) {
  /** @param {EditorTabs} tabs Replaces the tabs of the shown folder. */
  const setTabs = (tabs) => $folders.setKey(shownKey(), tabs);

  /**
   * Opens a tab (appended to the strip) or switches to it.
   * @param {string} path Tab id.
   */
  function open(path) {
    const tabs = $tabs.get();
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
  function close(path) {
    const rest = without($tabs.get(), path);
    if (rest) setTabs(rest);
  }

  /**
   * Opens a tab, active, among a folder's tabs, shown or not.
   * @param {string | null} root The folder; `null`: no project.
   * @param {string} path Tab id.
   */
  function openIn(root, path) {
    const key = root ?? NO_PROJECT;
    if (key === shownKey()) {
      open(path);
      return;
    }
    const tabs = $folders.get()[key] ?? NO_TABS;
    $folders.setKey(key, { ...tabs, paths: tabs.paths.includes(path) ? tabs.paths : [...tabs.paths, path], active: path });
  }

  /**
   * Closes a tab of any folder, shown or not, e.g. a terminal whose shell exited.
   * @param {string | null} root The folder; `null` for the tabs open with no project.
   * @param {string} path Tab id.
   */
  function closeIn(root, path) {
    const key = root ?? NO_PROJECT;
    if (key === shownKey()) {
      close(path);
      return;
    }
    const tabs = $folders.get()[key];
    const rest = tabs && without(tabs, path);
    if (rest) $folders.setKey(key, rest);
  }

  /**
   * Closes every tab but `path` and the pinned ones, and activates `path`.
   * @param {string} path Tab id.
   */
  function closeOthers(path) {
    const { paths, pinned } = $tabs.get();
    if (!paths.includes(path)) return;
    setTabs({ paths: paths.filter((p) => p === path || pinned.includes(p)), active: path, pinned });
  }

  /**
   * Closes the tabs after `path` but the pinned ones; activates `path` if the active tab was among them.
   * @param {string} path Tab id.
   */
  function closeToRight(path) {
    const { paths, active, pinned } = $tabs.get();
    const index = paths.indexOf(path);
    if (index === -1) return;
    const kept = paths.filter((p, i) => i <= index || pinned.includes(p));
    setTabs({ paths: kept, active: active !== null && kept.includes(active) ? active : path, pinned });
  }

  /** Closes every tab but the pinned ones. */
  function closeAll() {
    const { active, pinned } = $tabs.get();
    setTabs(tabsOf(pinned, active, pinned));
  }

  /**
   * Moves a tab within the strip; pinned tabs stay in front of the others.
   * @param {string} path Tab id.
   * @param {number} index In the strip without it.
   */
  function move(path, index) {
    const { paths, active, pinned } = $tabs.get();
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
  function setPinned(path, pin) {
    const { paths, active, pinned } = $tabs.get();
    if (!paths.includes(path) || pinned.includes(path) === pin) return;
    const pins = pin ? [...pinned, path] : pinned.filter((p) => p !== path);
    const rest = paths.filter((p) => p !== path && !pins.includes(p));
    setTabs({ paths: [...pins, ...(pin ? [] : [path]), ...rest], active, pinned: pins });
  }

  /** @param {string} path Id of an open tab. */
  function activate(path) {
    const tabs = $tabs.get();
    if (tabs.active !== path && tabs.paths.includes(path)) setTabs({ ...tabs, active: path });
  }

  /**
   * Forgets the tabs of a folder, e.g. when its project is removed from the app.
   * @param {string} root The folder.
   */
  function forget(root) {
    // Through `setKey`: `set()` would rewrite every folder's item from this window's copy.
    if (root in $folders.get()) $folders.setKey(root, undefined);
  }

  return { open, close, openIn, closeIn, closeOthers, closeToRight, closeAll, move, setPinned, activate, forget };
}
