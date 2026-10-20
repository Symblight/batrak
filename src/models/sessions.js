/** @typedef {import('./types.js').ConfirmOptions} ConfirmOptions */
/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').SessionIndicator} SessionIndicator */
/** @typedef {import('./types.js').SessionStatus} SessionStatus */

/** Statuses in which a session holds (or is getting) an agent process. */
export const RUNNING = new Set(['preparing', 'starting', 'idle', 'working', 'waiting']);

/** What a session's status icon says, also its tooltip. */
export const INDICATOR_LABELS = /** @type {const} */ ({
  permission: 'Waiting for your permission',
  error: 'Last turn failed',
  running: 'Agent is working',
});

/**
 * The one status a session shows, the most urgent first; `null` when there's nothing to say.
 * @param {SessionStatus} status
 * @param {boolean} permissionPending A permission request of it waits for the user.
 * @returns {SessionIndicator | null}
 */
export function sessionIndicator(status, permissionPending) {
  if (permissionPending || status === 'waiting') return 'permission';
  if (status === 'error') return 'error';
  if (status === 'preparing' || status === 'starting' || status === 'working') return 'running';
  return null;
}

/**
 * What removing a session asks first; the project's files stay either way.
 * @param {Session} session
 * @returns {ConfirmOptions}
 */
export function removeSessionConfirm(session) {
  return {
    headline: 'Remove session?',
    message: `"${session.title}" and its conversation will be deleted${RUNNING.has(session.status) ? ', and its agent stopped' : ''}.`,
    detail:
      session.mode === 'worktree'
        ? `Its worktree is deleted; uncommitted work is first committed onto ${session.branch}, which is kept if it has commits.`
        : 'Files the agent changed in the project stay as they are.',
    confirmLabel: 'Remove',
    destructive: true,
  };
}
