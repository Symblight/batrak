import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';

/** @typedef {import('../../models/types/types.js').FileDrag} FileDrag */

/**
 * The Tauri bridge, and the only module that imports `@tauri-apps/*`. A feature's commands (names
 * of Rust commands, their arguments) live in its own hook, built on this.
 */
export const ipc = Object.freeze({
  /**
   * Calls a Rust command.
   * @template T
   * @param {string} command
   * @param {Record<string, unknown> | number[] | ArrayBuffer | Uint8Array} [args]
   * @param {{ headers: Record<string, string> }} [options]
   * @returns {Promise<T>}
   */
  invoke(command, args, options) {
    return invoke(command, args, options);
  },

  /**
   * A channel the backend streams messages into.
   * @template T
   * @param {(message: T) => void} onMessage
   * @returns {Channel<T>}
   */
  channel(onMessage) {
    /** @type {Channel<T>} */
    const channel = new Channel();
    channel.onmessage = onMessage;
    return channel;
  },

  /**
   * Listens to a backend event, in any window.
   * @template T
   * @param {string} event
   * @param {(payload: T) => void} callback
   * @returns {Promise<() => void>} Stops listening.
   */
  listen(event, callback) {
    return listen(event, (e) => callback(/** @type {T} */ (e.payload)));
  },

  /** @returns {Promise<string>} The user's home folder. */
  homeDir() {
    return homeDir();
  },

  /**
   * Native folder picker.
   * @returns {Promise<string | null>} Selected path, or null if cancelled.
   */
  async pickFolder() {
    const result = await open({ directory: true, multiple: false });
    return typeof result === 'string' ? result : null;
  },

  /**
   * Files dragged from the OS over this window, and dropped (Tauri's native drag and drop, so the
   * page gets no HTML5 `drop` for them).
   * @param {(drag: FileDrag) => void} callback
   * @returns {Promise<() => void>} Stops listening.
   */
  onDragDrop(callback) {
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'leave') callback({ type: 'leave' });
      else if (payload.type === 'over') callback({ type: 'over', position: { x: payload.position.x, y: payload.position.y } });
      else callback({ type: payload.type, paths: payload.paths, position: { x: payload.position.x, y: payload.position.y } });
    });
  },
});
