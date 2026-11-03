import { app } from '../app/app.js';
import { notify } from '../../stores/notices/notices.js';
import { composerOf, revertConfigOption, setConfigOption } from '../../stores/composer/composer.js';
import { upsertSession, $sessions } from '../../stores/sessions/sessions.js';
import { $permissionRequests, dismissSessionNotice, removePermissionRequest, setSessionNotice } from '../../stores/session-runtime/session-runtime.js';
import {
  sessionApplyLocally,
  sessionCancelSubagent,
  sessionCheckOutBranch,
  sessionOpenLog,
  sessionRename,
  sessionResetTitle,
  sessionRespondPermission,
  sessionRestart,
  sessionSetConfigOption,
  sessionStop,
} from './commands.js';

/**
 * Sets the agent's model, thought level or mode for a session. Shown at once; a running agent gets
 * it now (and its answer replaces the options), otherwise it gets it when it starts.
 * @param {string} id A session's or a draft's.
 * @param {string} configId
 * @param {string} value
 */
function setConfigOptionFor(id, configId, value) {
  const previous = composerOf(id).configOptions.find((o) => o.id === configId)?.currentValue;
  setConfigOption(id, configId, value);
  const status = $sessions.get().find((s) => s.id === id)?.status;
  if (status !== 'idle' && status !== 'working' && status !== 'waiting') return;
  sessionSetConfigOption(id, configId, value).catch((err) => {
    if (previous !== undefined) revertConfigOption(id, configId, previous);
    app.reportError('The agent refused the change', err);
  });
}

/**
 * Answers the agent's permission request.
 * @param {string} id
 * @param {string} requestId
 * @param {string | null} optionId `null` cancels it.
 */
function respondPermission(id, requestId, optionId) {
  removePermissionRequest(id, requestId);
  sessionRespondPermission(id, requestId, optionId).catch((err) => app.reportError('Answering the agent failed', err));
}

/**
 * Stops one subagent of the session; the backend answers its permission requests `cancelled`, which
 * leave the banner then (a refused stop keeps them to answer).
 * @param {string} id
 * @param {string} subagentId
 */
function cancelSubagent(id, subagentId) {
  sessionCancelSubagent(id, subagentId).then(
    () => {
      for (const request of $permissionRequests.get()[id] ?? []) {
        if (request.subagentId === subagentId) removePermissionRequest(id, request.requestId);
      }
    },
    (err) => app.reportError('Stopping the subagent failed', err),
  );
}

/**
 * Stops the agent and its whole process tree; the next message starts it again.
 * @param {string} id
 */
function stop(id) {
  sessionStop(id).catch((err) => app.reportError('Stopping the agent failed', err));
}

/**
 * Brings a worktree session's work (commits and uncommitted changes since it started) into the
 * project's checkout as unstaged changes; says what happened.
 * @param {string} id
 */
async function applyLocally(id) {
  const title = $sessions.get().find((s) => s.id === id)?.title ?? 'the session';
  try {
    const result = await sessionApplyLocally(id);
    if (result.outcome === 'conflicts') notify('warn', `Applied "${title}" with conflicts in ${result.conflicts.join(', ')}`);
    else if (result.outcome === 'empty') notify('info', `"${title}" has no changes to apply`);
    else notify('info', `Applied "${title}" to the project, unstaged`);
  } catch (err) {
    app.reportError('Applying the session failed', err);
  }
}

/**
 * Stops a worktree session's agent and checks its branch out in the project.
 * @param {string} id
 */
async function checkOutBranch(id) {
  const branch = $sessions.get().find((s) => s.id === id)?.branch ?? 'the branch';
  try {
    await sessionCheckOutBranch(id);
    notify('info', `Checked out ${branch}`);
  } catch (err) {
    app.reportError(`Checking out ${branch} failed`, err);
  }
}

/**
 * Starts the agent again (after an error, or to resume a stopped session with its history).
 * @param {string} id
 */
function restart(id) {
  setSessionNotice(id, { kind: 'progress', message: 'Starting agent…' });
  sessionRestart(id).catch((err) => app.reportError('Restarting the agent failed', err));
}

/**
 * Gives a session a new title; a blank or unchanged one is ignored.
 * @param {string} id
 * @param {string} title
 */
async function rename(id, title) {
  const session = $sessions.get().find((s) => s.id === id);
  const trimmed = title.trim();
  if (!session || trimmed === '' || trimmed === session.title) return;
  try {
    upsertSession(await sessionRename(id, trimmed));
  } catch (err) {
    app.reportError('Renaming the session failed', err);
  }
}

/**
 * Gives a renamed session back its agent's title, which the agent then keeps up to date.
 * @param {string} id
 */
async function resetTitle(id) {
  try {
    upsertSession(await sessionResetTitle(id));
  } catch (err) {
    app.reportError('Resetting the title failed', err);
  }
}

/** @param {string} id */
function openLog(id) {
  sessionOpenLog(id).catch((err) => app.reportError('Opening the agent log failed', err));
}

/** @param {string} id */
function dismissNotice(id) {
  dismissSessionNotice(id);
}

/** What the user does to one session, each a call to the backend that reports its own failure. */
export const actions = Object.freeze({
  setConfigOption: setConfigOptionFor,
  respondPermission,
  cancelSubagent,
  stop,
  applyLocally,
  checkOutBranch,
  restart,
  rename,
  resetTitle,
  openLog,
  dismissNotice,
});
