import { setFileDropTarget } from '../../stores/file-drop/file-drop.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { chatDropOf, composedContains, deepElementFromPoint, dropTargetAt, osScale, toCssPoint } from './rules.js';

/** @typedef {import('./types.js').FileDrag} FileDrag */
/** @typedef {import('./types.js').FileDrop} FileDrop */
/** @typedef {import('./types.js').DroppedEntry} DroppedEntry */

/** What takes files dropped from the OS; the column rendering one handles the drop. */
const DROP_TARGETS = 'acp-terminal, acp-chat';

/** @type {Set<(drop: FileDrop) => void>} */
const listeners = new Set();

/** The dragged files, from `enter`; none for a drag of anything else. */
let paths = /** @type {readonly string[]} */ ([]);

/**
 * @param {{ x: number, y: number }} position
 * @returns {Element | null}
 */
function targetAt(position) {
  const { x, y } = toCssPoint(position, app.platform, devicePixelRatio);
  return dropTargetAt(document, x, y, DROP_TARGETS);
}

/**
 * Files dragged from the OS over the window (Tauri's native drag and drop): marks the drop target
 * under them in `$fileDropTarget` and tells the `onDrop` listeners when they're dropped on one.
 */
export const fileDrop = Object.freeze({
  deepElementFromPoint,
  dropTargetAt,
  composedContains,
  osScale,
  toCssPoint,
  chatDropOf,

  /** Listens to the webview's drags, for the page's lifetime. */
  start() {
    ipc.onDragDrop((drag) => fileDrop.handle(drag)).catch((err) => app.reportError('Listening for dropped files failed', err));
  },

  /**
   * Files dropped on a drop target; a drop elsewhere does nothing.
   * @param {(drop: FileDrop) => void} listener
   * @returns {() => void} Stops listening.
   */
  onDrop(listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },

  /**
   * What paths of this window's recent file drops are on disk; fails for a path it didn't drop.
   * @param {readonly string[]} dropped Absolute, as the drop named them.
   * @returns {Promise<DroppedEntry['kind'][]>} In the same order.
   */
  kinds(dropped) {
    return ipc.invoke('dropped_kinds', { paths: dropped });
  },

  /** @param {FileDrag} drag */
  handle(drag) {
    if (drag.type === 'leave') {
      paths = [];
      setFileDropTarget(null);
      return;
    }
    if (drag.type === 'enter') paths = drag.paths;
    const target = paths.length || drag.type === 'drop' ? targetAt(drag.position) : null;
    if (drag.type !== 'drop') {
      setFileDropTarget(target);
      return;
    }
    paths = [];
    setFileDropTarget(null);
    if (target && drag.paths.length) {
      for (const listener of [...listeners]) listener({ target, paths: drag.paths });
    }
  },
});
