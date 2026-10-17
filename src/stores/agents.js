import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').AgentList} AgentList */

/**
 * The agents configured for the open project (built-in, user-level and `.brama/agents.json`), kept
 * current by `agentConfig` as the file changes.
 */
export const $agentList = atom(/** @type {AgentList} */ ({ agents: [], defaultAgent: null, errors: [] }));
