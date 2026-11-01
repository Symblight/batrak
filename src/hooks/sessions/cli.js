import { app } from '../app/app.js';
import { sessionCliBusy, sessionCloseCli, sessionOpenCli, sessionResume, sessionStop } from './commands.js';
import { forgetHistory } from './adapter.js';
import { terminals } from '../terminals/terminals.js';
import { cancelIdleStop } from './idle.js';
import { RUNNING } from './rules.js';
import { $sessions } from '../../stores/sessions/sessions.js';
import { resetHistory } from '../../stores/chat/chat.js';
import { $terminals, addSessionTerminal, forgetTerminal, sessionTerminalOf, setCliStarting, terminalFailed } from '../../stores/terminals/terminals.js';

/** A CLI starts at this size; its view sends the real one once attached. */
export const CLI_SIZE = { cols: 80, rows: 24 };

/** @type {Map<string, Promise<void>>} Sessions whose CLI is starting, so a second ask doesn't start another. */
const cliOpening = new Map();

/**
 * Closes the session's CLI and resumes its agent, whose replay rebuilds the chat with the turns the
 * CLI ran.
 * @param {string} id
 */
export async function toChat(id) {
  await cliOpening.get(id);
  await closeCli(id);
  resetHistory(id);
  forgetHistory(id);
  // Not `#resume`: the activity another app showed was this CLI's.
  if ($sessions.get().find((s) => s.id === id)?.status === 'stopped')
    await sessionResume(id).catch((err) => app.reportError('Starting the agent failed', err));
}

/**
 * Starts the CLI again after it exited or failed to start.
 * @param {string} id
 */
export async function restartCli(id) {
  await closeCli(id);
  await openCli(id);
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} Closing its CLI would stop its work.
 */
export function cliBusy(id) {
  return sessionTerminalOf(id) === null ? Promise.resolve(false) : sessionCliBusy(id).catch(() => false);
}

/**
 * Starts the session's CLI unless it runs; once however many ask meanwhile.
 * @param {string} id
 * @returns {Promise<void>}
 */
export function openCli(id) {
  let opening = cliOpening.get(id);
  if (!opening) {
    opening = startCli(id).finally(() => cliOpening.delete(id));
    cliOpening.set(id, opening);
  }
  return opening;
}

/** @param {string} id */
async function startCli(id) {
  const session = $sessions.get().find((s) => s.id === id);
  const running = sessionTerminalOf(id);
  if (!session || (running !== null && $terminals.get()[running]?.status === 'running')) return;
  if (running !== null) forgetTerminal(running);
  cancelIdleStop(id);
  const label = session.agentName ?? 'Agent';
  // From now on, so the chat doesn't show while its agent stops.
  setCliStarting(id, true);
  try {
    if (RUNNING.has(session.status)) {
      try {
        await sessionStop(id);
      } catch (err) {
        app.reportError('Stopping the agent failed', err);
        return;
      }
    }
    const { terminalId } = await sessionOpenCli(id, CLI_SIZE.cols, CLI_SIZE.rows);
    addSessionTerminal(terminalId, id, session.folder, label);
  } catch (err) {
    // Shown in its place, with Restart and Continue in chat; never attached (the backend has no such terminal).
    const failed = `cli:${id}`;
    addSessionTerminal(failed, id, session.folder, label);
    terminalFailed(failed, `Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setCliStarting(id, false);
  }
}

/**
 * Closes the session's CLI, if it has one; resolves once it's gone.
 * @param {string} id
 */
export async function closeCli(id) {
  const terminalId = sessionTerminalOf(id);
  if (terminalId === null) return;
  const status = $terminals.get()[terminalId]?.status;
  if (status === 'running') await sessionCloseCli(id).catch((err) => app.reportError('Closing the terminal failed', err));
  // Exited by itself: the backend let the session go, but keeps its terminal's output.
  else if (status === 'exited') await terminals.close([terminalId]).catch(() => {});
  forgetTerminal(terminalId);
}
