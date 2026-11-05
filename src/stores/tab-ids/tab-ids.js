/** Prefix of a workspace's Changes tab id; the workspace's id follows. */
const WORKSPACE_CHANGES_PREFIX = 'view:workspace-changes:';

/**
 * @param {string} workspaceId
 * @returns {string} The id of the tab with a workspace's changes since its base.
 */
export function workspaceChangesTabId(workspaceId) {
  return `${WORKSPACE_CHANGES_PREFIX}${workspaceId}`;
}

/**
 * @param {string} id A tab id.
 * @returns {string | null} The workspace whose changes it shows; `null` for any other tab.
 */
export function workspaceOfTab(id) {
  return id.startsWith(WORKSPACE_CHANGES_PREFIX) ? id.slice(WORKSPACE_CHANGES_PREFIX.length) : null;
}

/** Prefix of a terminal's tab id; the terminal's id follows. */
const TERMINAL_PREFIX = 'view:terminal:';

/**
 * @param {string} terminalId
 * @returns {string} The id of the terminal's tab.
 */
export function terminalTabId(terminalId) {
  return `${TERMINAL_PREFIX}${terminalId}`;
}

/**
 * @param {string} id A tab id.
 * @returns {string | null} The terminal it shows; `null` for any other tab.
 */
export function terminalOfTab(id) {
  return id.startsWith(TERMINAL_PREFIX) ? id.slice(TERMINAL_PREFIX.length) : null;
}
