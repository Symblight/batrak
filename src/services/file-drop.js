import { dropTargetAt, toCssPoint } from '../models/file-drop.js';
import { PLATFORM } from '../models/platform.js';
import { setFileDropTarget } from '../stores/file-drop.js';
import { onFileDrag } from './ipc.js';
import { reportError } from './notices.js';

/** @typedef {import('../models/types.js').FileDrag} FileDrag */
/** @typedef {import('../models/types.js').FileDrop} FileDrop */

/** What takes files dropped from the OS; the column rendering one handles the drop. */
const DROP_TARGETS = 'acp-terminal, acp-chat';

/**
 * Files dragged from the OS over the window (Tauri's native drag and drop): marks the drop target
 * under them in `$fileDropTarget`.
 * Emits 'drop' (CustomEvent<FileDrop>) when they're dropped on one; a drop elsewhere does nothing.
 */
export class FileDropController extends EventTarget {
  /** @type {readonly string[]} The dragged files, from `enter`; none for a drag of anything else. */
  #paths = [];

  /** Listens to the webview's drags, for the page's lifetime. */
  start() {
    onFileDrag((drag) => this.handle(drag)).catch((err) => reportError('Listening for dropped files failed', err));
  }

  /**
   * @param {{ x: number, y: number }} position
   * @returns {Element | null}
   */
  #targetAt(position) {
    const { x, y } = toCssPoint(position, PLATFORM, devicePixelRatio);
    return dropTargetAt(document, x, y, DROP_TARGETS);
  }

  /** @param {FileDrag} drag */
  handle(drag) {
    if (drag.type === 'leave') {
      this.#paths = [];
      setFileDropTarget(null);
      return;
    }
    if (drag.type === 'enter') this.#paths = drag.paths;
    const target = this.#paths.length || drag.type === 'drop' ? this.#targetAt(drag.position) : null;
    if (drag.type !== 'drop') {
      setFileDropTarget(target);
      return;
    }
    this.#paths = [];
    setFileDropTarget(null);
    if (target && drag.paths.length) {
      /** @type {FileDrop} */
      const detail = { target, paths: drag.paths };
      this.dispatchEvent(new CustomEvent('drop', { detail }));
    }
  }
}

export const fileDrop = new FileDropController();
