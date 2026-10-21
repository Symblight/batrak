import { atom } from 'nanostores';

/** @typedef {import('../models/types.js').AgentList} AgentList */

/**
 * The agents of the open project (its `.brama/agents.json`; the user's file with none), kept
 * current by `agentConfig` as the file changes.
 */
export const $agentList = atom(/** @type {AgentList} */ ({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] }));
