import { cliPromptOf } from '../models/cli-input.js';
import { sessionController } from './session-controller.js';
import { $agentList } from '../stores/agents.js';
import { composerOf } from '../stores/composer.js';
import { $sessionNotices, setSessionNotice } from '../stores/session-runtime.js';
import { $draftSessions } from '../stores/sessions.js';

/** @typedef {import('../models/types.js').SessionInput} SessionInput */

/**
 * Whether a session took what was sent; when not, why (also shown as its notice). The sender keeps
 * the input (the composer clears only when it was taken).
 * @typedef {{ taken: true } | { taken: false, reason: string }} SendOutcome
 */

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
   * A `terminal-draft`'s first send: its agent's CLI starts with it as its first prompt, its refs
   * whole paths. Attachments are refused: the CLI can't take them yet.
   * @param {string} id
   * @param {SessionInput} input
   * @param {string} title
   * @returns {Promise<SendOutcome>}
   */
  async startTerminal(id, input, title) {
    const { agentId, runTarget } = composerOf(id);
    const name = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? 'The agent';
    if (input.files.length) {
      const files = input.files.map((f) => f.name).join(', ');
      const reason = `${name}'s terminal can't take attachments yet: remove ${files} to start it`;
      setSessionNotice(id, { kind: 'error', message: reason });
      return { taken: false, reason };
    }
    // In a worktree, a path of the project stays absolute: it's the user's file, not the worktree's copy.
    const root = runTarget.kind === 'local' ? ($draftSessions.get()[id] ?? null) : null;
    if (await sessionController.startInTerminal(id, title, cliPromptOf(input.parts, root))) return { taken: true };
    const reason = $sessionNotices.get()[id]?.message ?? `${name} didn't start`;
    setSessionNotice(id, { kind: 'error', message: reason });
    return { taken: false, reason };
  },
};
