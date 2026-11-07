import { ipc } from '../ipc/ipc.js';

/** The offer to create `AGENTS.md` on a new session (spec: `docs/specs/agents-md.md`). */
export const agentsMd = Object.freeze({
  /**
   * Whether the root's folder lacks `AGENTS.md`.
   * @param {string} rootId
   * @returns {Promise<boolean>}
   */
  needed(rootId) {
    return ipc.invoke('needs_agents_md', { rootId });
  },
});
