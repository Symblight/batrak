import { $openRoots } from '../../stores/project/project.js';

/**
 * The backend roots a window keeps open, projects' and workspaces' folders together, mirrored into
 * `$openRoots`. Switching to one of them needs no scan: its watcher kept the snapshot current.
 * @param {number} limit How many stay open; the least recently shown beyond it close.
 * @param {(rootId: string) => Promise<void>} close Closes a root in the backend.
 */
export function createRoots(limit, close) {
  /** @type {Map<string, string>} Root ids by folder, least recently shown first. */
  const open = new Map();
  const order = () => [...open.keys()];
  const publish = () => $openRoots.set(Object.fromEntries(open));

  /**
   * @param {string} path
   * @returns {Promise<void>} Settles once the backend closed it.
   */
  function forget(path) {
    const rootId = open.get(path);
    if (rootId === undefined) return Promise.resolve();
    open.delete(path);
    publish();
    return close(rootId);
  }

  /** @param {readonly string[]} pinned Never closed. */
  function evict(pinned) {
    for (const path of order().filter((other) => !pinned.includes(other))) {
      if (open.size <= limit) break;
      void forget(path);
    }
  }

  return Object.freeze({
    /**
     * @param {string} path
     * @returns {string | null} Its root's id while open.
     */
    get(path) {
      return open.get(path) ?? null;
    },

    /**
     * Makes a root the most recently shown, closing the oldest beyond the limit.
     * @param {string} path
     * @param {string} rootId
     * @param {readonly string[]} [pinned] Kept open too: the shown workspace's project.
     */
    show(path, rootId, pinned = []) {
      open.delete(path);
      open.set(path, rootId);
      publish();
      evict([path, ...pinned]);
    },

    /**
     * Keeps a root opened while another was shown, as the least recently shown.
     * @param {string} path
     * @param {string} rootId
     * @param {readonly string[]} pinned Kept open: what is shown.
     */
    keepOlder(path, rootId, pinned) {
      const rest = [...open].filter(([other]) => other !== path);
      open.clear();
      for (const [other, id] of [[path, rootId], ...rest]) open.set(other, id);
      publish();
      evict(pinned);
    },

    /** Closes a folder's root, if open. */
    close: forget,

    /**
     * @param {string} rootId
     * @returns {boolean} Whether it is still open.
     */
    isOpen(rootId) {
      return [...open.values()].includes(rootId);
    },
  });
}
