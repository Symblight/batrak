/** @typedef {import('./types.js').RunTarget} RunTarget */

/**
 * Where a draft's first message creates its chat: the place picked, else its workspace's own (This
 * workspace in a worktree workspace, Local in Main, which has no This workspace). New worktree only
 * where the project can have workspaces (`$workspacesEnabled`).
 * @param {RunTarget | undefined} picked
 * @param {string} workspaceId The draft's; `main` for Main.
 * @param {boolean} [worktrees] The project can have workspaces.
 * @returns {RunTarget}
 */
export function runTargetOf(picked, workspaceId, worktrees = true) {
  const main = workspaceId === 'main';
  const unavailable = picked?.kind === 'worktree' ? !worktrees : picked?.kind === 'workspace' && main;
  if (picked === undefined || unavailable) return main ? { kind: 'local' } : { kind: 'workspace' };
  return picked;
}
