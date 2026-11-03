import { atom } from 'nanostores';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */

/** The shown project's workspaces, oldest first, as the backend lists them (`workspaces` hook). */
export const $workspaces = atom(/** @type {readonly Workspace[]} */ ([]));

/** @param {readonly Workspace[]} list */
export function setWorkspaces(list) {
  $workspaces.set(list);
}
