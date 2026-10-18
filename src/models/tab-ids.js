/** Prefix of a worktree session's Changes tab id; the session's id follows. */
const SESSION_CHANGES_PREFIX = 'view:session-changes:';

/**
 * @param {string} sessionId
 * @returns {string} The id of the tab with a worktree session's changes since it started.
 */
export function sessionChangesTabId(sessionId) {
  return `${SESSION_CHANGES_PREFIX}${sessionId}`;
}

/**
 * @param {string} id A tab id.
 * @returns {string | null} The session whose changes it shows; `null` for any other tab.
 */
export function sessionOfTab(id) {
  return id.startsWith(SESSION_CHANGES_PREFIX) ? id.slice(SESSION_CHANGES_PREFIX.length) : null;
}
