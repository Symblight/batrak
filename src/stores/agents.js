import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').AgentList} AgentList */
/** @typedef {import('../models/types.js').AgentsView} AgentsView */
/** @typedef {import('../models/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../models/types.js').SignInRun} SignInRun */
/** @typedef {import('../models/types.js').SignInEvent} SignInEvent */

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

/** Sign-ins running or failed (`agents://sign-in`, any window's), by `signInKey()`. In memory. */
export const $signIns = atom(/** @type {Readonly<Record<string, SignInRun>>} */ ({}));

/**
 * @param {string | null} projectPath `null`: the user's agents.
 * @param {string} agentId
 */
function signInKey(projectPath, agentId) {
  return `${projectPath ?? ''}\n${agentId}`;
}

/**
 * How a sign-in goes: a running or failed one is kept, a done or cancelled one forgotten.
 * @param {SignInEvent} event
 */
export function noteSignIn({ projectPath, agentId, state, message }) {
  const { [signInKey(projectPath, agentId)]: _, ...rest } = $signIns.get();
  $signIns.set(state === 'waiting' || state === 'failed' ? { ...rest, [signInKey(projectPath, agentId)]: { state, message } } : rest);
}

/**
 * @param {string | null} projectPath
 * @param {string} agentId
 * @returns {SignInRun | null}
 */
export function signInOf(projectPath, agentId) {
  return $signIns.get()[signInKey(projectPath, agentId)] ?? null;
}
