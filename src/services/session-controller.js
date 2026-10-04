import { getActiveSession, listSessions, setActiveSession } from './ipc.js';
import { $activeSessionId, $sessions } from '../stores/sessions.js';

/** Loads sessions from the backend into `$sessions` / `$activeSessionId`. */
export class SessionController {
  /** @returns {Promise<void>} */
  async init() {
    $sessions.set(await listSessions());
    $activeSessionId.set(await getActiveSession());
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async select(id) {
    await setActiveSession(id);
    $activeSessionId.set(id);
  }
}

export const sessionController = new SessionController();
