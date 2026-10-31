import { atom } from 'nanostores';

/** The drop target files dragged from the OS are over (`acp-terminal`, `acp-chat`); `null` while none is or no drag runs. */
export const $fileDropTarget = atom(/** @type {Element | null} */ (null));

/** @param {Element | null} target */
export function setFileDropTarget(target) {
  $fileDropTarget.set(target);
}
