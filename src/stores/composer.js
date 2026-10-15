import { atom } from 'nanostores';
import { $activeSessionId } from './sessions.js';
import { $rootId } from './workspace.js';

/** @typedef {import('../models/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../models/types.js').ConfigOption} ConfigOption */
/** @typedef {import('../models/types.js').ComposerState} ComposerState */
/** @typedef {import('../models/types.js').RunTarget} RunTarget */

/** @type {ConfigOption} */
const PERMISSION_MODES = {
  id: 'mode',
  name: 'Permission mode',
  category: 'mode',
  type: 'select',
  currentValue: 'agent',
  options: [
    { value: 'plan', name: 'Plan', description: 'Plan first, change nothing' },
    { value: 'ask', name: 'Ask', description: 'Ask before each edit or command' },
    { value: 'agent', name: 'Agent', description: 'Edit and run in this workspace' },
    { value: 'full', name: 'Full access', description: 'Outside the workspace and online' },
  ],
};

/**
 * @param {string} current
 * @param {string[]} levels
 * @returns {ConfigOption}
 */
function thoughtLevels(current, levels) {
  return {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: levels.map((level) => ({ value: level.toLowerCase(), name: level })),
  };
}

/**
 * Mock catalogue until agents connect over ACP: each agent with the `configOptions` its
 * `session/new` would answer.
 * @type {readonly (AgentInfo & { configOptions: ConfigOption[], contextSize: number })[]}
 */
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Agent',
    glyph: 'CL',
    contextSize: 200_000,
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'opus', name: 'Opus 5.5' },
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'haiku', name: 'Haiku 5.5' },
        ],
      },
      thoughtLevels('medium', ['Low', 'Medium', 'High']),
      PERMISSION_MODES,
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    glyph: 'C',
    contextSize: 400_000,
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-5.6',
        options: [
          { value: 'gpt-5.6', name: 'GPT 5.6' },
          { value: 'gpt-5.6-mini', name: 'GPT 5.6 Mini' },
        ],
      },
      thoughtLevels('high', ['Low', 'Medium', 'High', 'Max']),
      PERMISSION_MODES,
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    glyph: 'G',
    contextSize: 1_000_000,
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-3.1-pro',
        options: [
          { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
          { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
        ],
      },
      PERMISSION_MODES,
    ],
  },
];

/** Mock branch list for the run-target menu; the project's current branch is added to it. */
export const MOCK_BRANCHES = ['main', 'feature/composer-v2', 'fix/session-jump'];

/** @param {string} agentId */
function agentOf(agentId) {
  return AGENTS.find((a) => a.id === agentId) ?? AGENTS[0];
}

/**
 * @param {string} agentId
 * @returns {ComposerState}
 */
function freshState(agentId) {
  return {
    agentId,
    configOptions: agentOf(agentId).configOptions.map((o) => ({ ...o })),
    usage: null,
    runTarget: { kind: 'local', branch: null },
    started: false,
  };
}

/** The chat's composer: agent, its ACP config options, context usage, where it runs. In memory. */
export const $composer = atom(freshState(AGENTS[0].id));

/**
 * The first option of a category, in the agent's order.
 * @param {readonly ConfigOption[]} options
 * @param {string} category
 */
export function configOf(options, category) {
  return options.find((o) => o.category === category) ?? null;
}

/**
 * @param {ConfigOption | null} option
 * @returns {string | null} The current value's name.
 */
export function currentName(option) {
  return option?.options.find((v) => v.value === option.currentValue)?.name ?? null;
}

/** @param {string} agentId */
export function agentInfo(agentId) {
  return agentOf(agentId);
}

/**
 * Switches agent before the session starts; its config options start from its defaults.
 * @param {string} agentId
 */
export function selectAgent(agentId) {
  const state = $composer.get();
  if (state.started || state.agentId === agentId) return;
  $composer.set({ ...freshState(agentId), runTarget: state.runTarget });
}

/**
 * Sets an ACP config option; later the agent's `session/set_config_option` answer replaces them all.
 * @param {string} configId
 * @param {string} value
 */
export function setConfigOption(configId, value) {
  const state = $composer.get();
  const configOptions = state.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
  $composer.set({ ...state, configOptions });
}

/** @param {Partial<RunTarget>} patch Ignored once the session started. */
export function setRunTarget(patch) {
  const state = $composer.get();
  if (state.started) return;
  $composer.set({ ...state, runTarget: { ...state.runTarget, ...patch } });
}

/** Another session or project: the composer starts over, with the same agent picked. */
function resetComposer() {
  $composer.set(freshState($composer.get().agentId));
}
$activeSessionId.listen(resetComposer);
$rootId.listen(resetComposer);

/** The first message went out: the agent and run target are fixed from now on. */
export function startComposerSession() {
  const state = $composer.get();
  if (state.started) return;
  // Mock until `usage_update` arrives over ACP.
  const usage = { used: 0, size: agentOf(state.agentId).contextSize, cost: { amount: 0, currency: 'USD' } };
  $composer.set({ ...state, started: true, usage });
}
