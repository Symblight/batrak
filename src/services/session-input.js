import { cliPromptOf } from '../models/cli-input.js';
import { sessionController } from './session-controller.js';
import { $agentList } from '../stores/agents.js';
import { composerOf } from '../stores/composer.js';
import { $sessionNotices, setSessionNotice } from '../stores/session-runtime.js';
import { $draftSessions, $sessions } from '../stores/sessions.js';

/** @typedef {import('../models/types.js').SessionInput} SessionInput */
/** @typedef {import('../models/types.js').SessionNotice} SessionNotice */

/**
 * Whether a session took what was sent; when not, why (also shown as its notice). The sender keeps
 * the input (the composer clears only when it was taken).
 * @typedef {{ taken: true } | { taken: false, reason: string }} SendOutcome
 */

/** @type {WeakSet<SessionNotice>} The notices `refuseFiles` set. */
const refusals = new WeakSet();

/**
 * Where what the user gives a session goes, whatever shows it: the one place that decides between
 * the chat and its agent's CLI.
 */
export const sessionInput = {
  /**
   * Where a draft's first send goes: `terminal-draft` starts its agent's CLI with it, `chat-draft`
   * the chat.
   * @param {string} id
   * @returns {'chat-draft' | 'terminal-draft' | null} `null` when it's no draft.
   */
  draftTarget(id) {
    if (!(id in $draftSessions.get())) return null;
    return sessionController.startsInTerminal(id) ? 'terminal-draft' : 'chat-draft';
  },

  /**
   * Refuses attachments, which neither the chat nor a CLI can be sent yet: the reason, also shown
   * as the session's notice, so the sender keeps them; `null` for none.
   * @param {string} id
   * @param {readonly File[]} files
   * @returns {string | null}
   */
  refuseFiles(id, files) {
    if (!files.length) return null;
    const agentId = $sessions.get().find((s) => s.id === id)?.agentId ?? composerOf(id).agentId;
    const name = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? 'The agent';
    const reason = `${name} can't be sent attachments yet: remove ${files.map((f) => f.name).join(', ')} to send`;
    // Covers the session's notice (a sign-in, agents.json changed), which comes back once dismissed;
    // an earlier refusal it replaces.
    const current = $sessionNotices.get()[id];
    const under = current && refusals.has(current) ? current.under : current;
    /** @type {SessionNotice} */
    const notice = { kind: 'info', message: reason, ...(under ? { under } : {}) };
    refusals.add(notice);
    setSessionNotice(id, notice);
    return reason;
  },

  /**
   * A `terminal-draft`'s first send: its agent's CLI starts with it as its first prompt, its refs
   * whole paths; attachments were refused before (`refuseFiles`).
   * @param {string} id
   * @param {SessionInput} input
   * @param {string} title
   * @returns {Promise<SendOutcome>}
   */
  async startTerminal(id, input, title) {
    const { agentId, runTarget } = composerOf(id);
    const name = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? 'The agent';
    // In a worktree, a path of the project stays absolute: it's the user's file, not the worktree's copy.
    const root = runTarget.kind === 'local' ? ($draftSessions.get()[id] ?? null) : null;
    if (await sessionController.startInTerminal(id, title, cliPromptOf(input.parts, root))) return { taken: true };
    const reason = $sessionNotices.get()[id]?.message ?? `${name} didn't start`;
    setSessionNotice(id, { kind: 'error', message: reason });
    return { taken: false, reason };
  },
};
