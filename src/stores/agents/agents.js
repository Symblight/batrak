import { atom } from 'nanostores';
import { $terminals, closeTerminalTab } from '../terminals/terminals.js';

/** @typedef {import('../../hooks/agents/types.js').AgentList} AgentList */
/** @typedef {import('../../hooks/agents/types.js').AgentsView} AgentsView */
/** @typedef {import('../../hooks/agents/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../hooks/agents/types.js').SignInRun} SignInRun */
/** @typedef {import('../../hooks/agents/types.js').SignInEvent} SignInEvent */

/**
 * The agents of the open project (its `.brama/agents.json`; the user's file with none), kept
 * current by the `agents` hook as the file changes.
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
 * How a sign-in goes: a running or failed one is kept, a done or cancelled one forgotten. A
 * cancelled login's tab, this window's, closes: its terminal is gone and says so no more.
 * @param {SignInEvent} event
 */
export function noteSignIn({ projectPath, agentId, state, message, terminal }) {
  const login = terminal && $terminals.get()[terminal.terminalId];
  if (state === 'cancelled' && terminal && login) closeTerminalTab(login.projectPath, terminal.terminalId);
  const { [signInKey(projectPath, agentId)]: _, ...rest } = $signIns.get();
  const kept = state === 'waiting' || state === 'failed';
  $signIns.set(kept ? { ...rest, [signInKey(projectPath, agentId)]: { state, message, terminal } } : rest);
}

/**
 * One project's sign-ins, by agent id.
 * @param {Readonly<Record<string, SignInRun>>} signIns `$signIns`' value.
 * @param {string | null} projectPath `null`: the user's agents.
 * @returns {Record<string, SignInRun>}
 */
export function signInsOf(signIns, projectPath) {
  const prefix = signInKey(projectPath, '');
  return Object.fromEntries(
    Object.entries(signIns)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, run]) => [key.slice(prefix.length), run]),
  );
}

/**
 * @param {string | null} projectPath
 * @param {string} agentId
 * @returns {SignInRun | null}
 */
export function signInOf(projectPath, agentId) {
  return $signIns.get()[signInKey(projectPath, agentId)] ?? null;
}
