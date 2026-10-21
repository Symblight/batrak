import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').AgentList} AgentList */
/** @typedef {import('../models/types.js').AgentsView} AgentsView */
/** @typedef {import('../models/types.js').AgentsQuery} AgentsQuery */

/**
 * The agents of the open project (its `.brama/agents.json`; the user's file with none), kept
 * current by `agentConfig` as the file changes.
 */
export const $agentList = atom(/** @type {AgentList} */ ({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] }));

/** The Agents tab's data for `$agentsQuery`, as the backend answered it last; `null` before its first answer. */
export const $agentsView = atom(/** @type {AgentsView | null} */ (null));

/**
 * Calls this window waits for: agents being updated, a registry check. The tab shows them at once,
 * before the backend's answer says so.
 * @type {import('nanostores').WritableAtom<{ updating: readonly string[], checking: boolean }>}
 */
export const $agentsPending = atom({ updating: /** @type {readonly string[]} */ ([]), checking: false });

/**
 * Runs `call` with `ids` shown as updating meanwhile.
 * @template T
 * @param {readonly string[]} ids
 * @param {() => Promise<T>} call
 */
export async function whileUpdating(ids, call) {
  const add = $agentsPending.get();
  $agentsPending.set({ ...add, updating: [...add.updating, ...ids] });
  try {
    return await call();
  } finally {
    const now = $agentsPending.get();
    const left = [...now.updating];
    for (const id of ids) left.splice(left.indexOf(id), 1);
    $agentsPending.set({ ...now, updating: left });
  }
}

/** The Agents tab's search and filter chip. In memory. */
export const $agentsQuery = atom(/** @type {AgentsQuery} */ ({ query: '', filter: 'all' }));
