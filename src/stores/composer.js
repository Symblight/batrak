import { atom, computed } from 'nanostores';
import { $activeSessionId, $sessions } from './sessions.js';
import { $agentList } from './agents.js';
import { $workspaceSettings } from './workspace.js';
import { isRecord, persistentStore } from './persistent.js';

/** @typedef {import('../models/types.js').ConfigOption} ConfigOption */
/** @typedef {import('../models/types.js').ComposerState} ComposerState */
/** @typedef {import('../models/types.js').RunTarget} RunTarget */
/** @typedef {import('../models/types.js').Session} Session */

/** @typedef {import('../models/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../models/types.js').AcpConfigOption} AcpConfigOption */

/**
 * Each agent's config options by agent id, so a new session shows the agent's real models and
 * levels before it starts. `currentValue` is the agent's own default as first learned (a probe
 * replaces it), not what some session was switched to. Shared by every window.
 */
const $agentOptions = persistentStore(
  'brama:agents:config-options',
  /** @type {Readonly<Record<string, ConfigOption[]>>} */ ({}),
  {
    parse: (raw) =>
      isRecord(raw)
        ? Object.fromEntries(Object.entries(raw).map(([id, options]) => [id, normalizeOptions(options)]))
        : null,
  },
);

/**
 * @param {unknown} raw
 * @returns {Record<string, Record<string, string>> | null}
 */
function parsePicks(raw) {
  if (!isRecord(raw)) return null;
  /** @type {Record<string, Record<string, string>>} */
  const picks = {};
  for (const [agentId, values] of Object.entries(raw)) {
    if (!isRecord(values)) continue;
    picks[agentId] = {};
    for (const [id, value] of Object.entries(values)) if (typeof value === 'string') picks[agentId][id] = value;
  }
  return picks;
}

/**
 * What the user last picked for each agent's options, by agent id, then option id: a new session
 * of the agent starts with them. No permission mode (category `mode`): a new session starts in the
 * agent's own, never in one another session was given. Shared by every window.
 */
const $lastPicks = persistentStore(
  'brama:agents:last-picks',
  /** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */ ({}),
  { parse: parsePicks },
);

/**
 * @param {ConfigOption} option
 * @param {string | undefined} value
 */
function offers(option, value) {
  return value !== undefined && option.options.some((v) => v.value === value);
}

/**
 * The options with the given values shown where they offer them.
 * @param {ConfigOption[]} options
 * @param {Readonly<Record<string, string>>} values By option id.
 */
function withValues(options, values) {
  return options.map((o) => (offers(o, values[o.id]) ? { ...o, currentValue: values[o.id] } : o));
}

/**
 * ACP config options as the composer shows them: select options only, groups flattened.
 * @param {unknown} options ACP `SessionConfigOption[]` as the agent sent it (or as stored).
 * @returns {ConfigOption[]}
 */
export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.flatMap((/** @type {unknown} */ raw) => {
    if (!isRecord(raw) || raw.type !== 'select' || typeof raw.id !== 'string' || !Array.isArray(raw.options)) return [];
    const values = raw.options.flatMap((/** @type {unknown} */ v) =>
      isRecord(v) && Array.isArray(v.options) ? v.options : [v],
    );
    /** @type {ConfigOption['options']} */
    const flat = values.flatMap((/** @type {unknown} */ v) =>
      isRecord(v) && typeof v.value === 'string'
        ? [{ value: v.value, name: typeof v.name === 'string' ? v.name : v.value, ...(typeof v.description === 'string' ? { description: v.description } : {}) }]
        : [],
    );
    if (!flat.length) return [];
    return [
      {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(typeof raw.category === 'string' ? { category: raw.category } : {}),
        type: /** @type {const} */ ('select'),
        currentValue: typeof raw.currentValue === 'string' ? raw.currentValue : flat[0].value,
        options: flat,
      },
    ];
  });
}

/**
 * One or two letters for an agent's badge.
 * @param {string} name
 */
function glyphOf(name) {
  const words = name.split(/[\s-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * @param {{ id: string, name: string }} agent
 * @returns {CatalogAgent}
 */
function catalogEntry({ id, name }) {
  return { id, name, glyph: glyphOf(name), configOptions: $agentOptions.get()[id] ?? [] };
}

/** The agents the project can run (`$agentList`), each with its config options as last seen. */
export const $agents = computed([$agentList, $agentOptions], (list) => list.agents.map(catalogEntry));

/**
 * An agent of the catalogue; one that isn't configured (any more) shows by its id.
 * @param {string} agentId
 */
function agentOf(agentId) {
  return $agents.get().find((a) => a.id === agentId) ?? catalogEntry({ id: agentId, name: agentId });
}

/**
 * A draft's: the agent's defaults with the user's last picks for it, which are sent when it starts.
 * @param {string} agentId
 * @returns {ComposerState}
 */
function freshState(agentId) {
  const options = agentOf(agentId).configOptions;
  const picks = $lastPicks.get()[agentId] ?? {};
  // With the options unknown, every pick goes; the backend leaves out what the agent lacks.
  const chosen = options.length
    ? Object.fromEntries(Object.entries(picks).filter(([id, value]) => options.some((o) => o.id === id && offers(o, value))))
    : { ...picks };
  return {
    agentId,
    configOptions: withValues(options, chosen),
    chosen,
    usage: null,
    runTarget: { kind: $workspaceSettings.get().defaultMode, branch: null },
    started: false,
  };
}

/**
 * A listed session's before its agent reports (after a reload): its own agent, values and run target.
 * @param {Session} session
 * @returns {ComposerState}
 */
function listedState(session) {
  return {
    agentId: session.agentId,
    configOptions: withValues(agentOf(session.agentId).configOptions, session.config),
    chosen: {},
    usage: null,
    runTarget: { kind: session.mode, branch: session.mode === 'worktree' ? session.branch : null },
    started: true,
  };
}

/** The agent last picked; a new session starts with it while it's configured. */
const $lastAgentId = atom(/** @type {string | null} */ (null));

/** The agent a new session starts with: the last picked, else the config's default, else the first. */
const $newSessionAgentId = computed([$lastAgentId, $agentList], (last, list) => {
  if (last !== null && list.agents.some((a) => a.id === last)) return last;
  return list.defaultAgent ?? list.agents[0]?.id ?? 'claude';
});

/** Each session's composer by session id, once it differs from a fresh one. In memory. */
const $composers = atom(/** @type {Readonly<Record<string, ComposerState>>} */ ({}));

/** The active session's composer: agent, its ACP config options, context usage, where it runs. */
export const $composer = computed(
  [$composers, $activeSessionId, $sessions, $newSessionAgentId, $agents, $workspaceSettings, $lastPicks],
  (_composers, id, _sessions, agentId) => (id === null ? freshState(agentId) : composerOf(id)),
);

/**
 * @param {string} id A session's or a draft's.
 * @returns {ComposerState}
 */
export function composerOf(id) {
  const stored = $composers.get()[id];
  if (stored) return stored;
  const session = $sessions.get().find((s) => s.id === id);
  return session ? listedState(session) : freshState($newSessionAgentId.get());
}

/**
 * @param {string} id
 * @param {(state: ComposerState) => ComposerState} update
 */
function updateComposer(id, update) {
  const state = composerOf(id);
  const next = update(state);
  if (next !== state) $composers.set({ ...$composers.get(), [id]: next });
}

/** @param {(state: ComposerState) => ComposerState} update Ignored with no active session. */
function updateActive(update) {
  const id = $activeSessionId.get();
  if (id !== null) updateComposer(id, update);
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
  $lastAgentId.set(agentId);
  updateActive((s) => ({ ...freshState(agentId), runTarget: s.runTarget }));
}

/**
 * The user picked a config option value: shown at once and kept as chosen until the agent
 * confirms it (`applyAgentOptions()`), so a pick made before the agent runs reaches it on start.
 * New sessions of the agent start with it too, unless it's a permission mode.
 * @param {string} id A session's or a draft's.
 * @param {string} configId
 * @param {string} value
 */
export function setConfigOption(id, configId, value) {
  const { agentId, configOptions } = composerOf(id);
  const option = configOptions.find((o) => o.id === configId);
  if (option && option.category !== 'mode') {
    const picks = $lastPicks.get();
    $lastPicks.set({ ...picks, [agentId]: { ...picks[agentId], [configId]: value } });
  }
  updateComposer(id, (state) => ({
    ...state,
    configOptions: state.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
    chosen: { ...state.chosen, [configId]: value },
  }));
}

/**
 * Forgets a pick the agent refused, for new sessions too (they get `previous` again); its options
 * come back as the agent has them.
 * @param {string} id
 * @param {string} configId
 * @param {string} previous The value shown before the pick.
 */
export function revertConfigOption(id, configId, previous) {
  const { agentId, chosen: pending } = composerOf(id);
  const picks = $lastPicks.get();
  const refused = picks[agentId]?.[configId];
  if (refused !== undefined && refused === pending[configId]) {
    $lastPicks.set({ ...picks, [agentId]: { ...picks[agentId], [configId]: previous } });
  }
  updateComposer(id, (state) => {
    const { [configId]: _, ...chosen } = state.chosen;
    return {
      ...state,
      configOptions: state.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: previous } : o)),
      chosen,
    };
  });
}

/**
 * The agent's config options (at start, after a change, or its own update) replace the session's,
 * and become what new sessions of the agent show, keeping the defaults already known. Picks the
 * agent doesn't have yet are returned, to be sent to it; picks it now has are done.
 * @param {string} id A session's.
 * @param {unknown} agentOptions ACP `SessionConfigOption[]`.
 * @returns {{ configId: string, value: string }[]} Picks still to send.
 */
export function applyAgentOptions(id, agentOptions) {
  const options = normalizeOptions(agentOptions);
  const state = composerOf(id);
  /** @type {Record<string, string>} */
  const chosen = {};
  for (const [configId, value] of Object.entries(state.chosen)) {
    const option = options.find((o) => o.id === configId);
    // A pick the agent can't take (the option is gone, or the value) is dropped.
    if (option && option.currentValue !== value && option.options.some((v) => v.value === value)) chosen[configId] = value;
  }
  // What the agent will be set to shows now.
  const shown = options.map((o) => (o.id in chosen ? { ...o, currentValue: chosen[o.id] } : o));
  updateComposer(id, (s) => ({ ...s, configOptions: shown, chosen }));
  const known = $agentOptions.get()[state.agentId] ?? [];
  const defaults = Object.fromEntries(known.map((o) => [o.id, o.currentValue]));
  $agentOptions.set({ ...$agentOptions.get(), [state.agentId]: withValues(options, defaults) });
  return Object.entries(chosen).map(([configId, value]) => ({ configId, value }));
}

/** @param {Partial<RunTarget>} patch Ignored once the session started. */
export function setRunTarget(patch) {
  updateActive((state) => (state.started ? state : { ...state, runTarget: { ...state.runTarget, ...patch } }));
}

/**
 * The session's first message went out: its agent and run target are fixed from now on.
 * @param {string} id
 */
export function startComposer(id) {
  updateComposer(id, (state) => (state.started ? state : { ...state, started: true }));
}

/**
 * The agent's `usage_update`: context used and its size in tokens, and the session's cost so far.
 * @param {string} id A session's.
 * @param {import('../models/types.js').ContextUsage} usage
 */
export function setUsage(id, usage) {
  updateComposer(id, (state) => ({ ...state, usage }));
}

/**
 * Drops a removed session's composer.
 * @param {string} id
 */
export function forgetComposer(id) {
  const { [id]: dropped, ...rest } = $composers.get();
  if (dropped) $composers.set(rest);
}

/** @param {string} agentId Whether the agent's options are known (cached from a session or a probe). */
export function hasAgentOptions(agentId) {
  return agentId in $agentOptions.get();
}

/**
 * An agent's options learned without a session (a probe): cached for new sessions, and given to
 * drafts of the agent that have none yet (keeping what was picked).
 * @param {string} agentId
 * @param {unknown} agentOptions ACP `SessionConfigOption[]`.
 */
export function cacheAgentOptions(agentId, agentOptions) {
  const options = normalizeOptions(agentOptions);
  $agentOptions.set({ ...$agentOptions.get(), [agentId]: options });
  const composers = $composers.get();
  /** @type {Record<string, ComposerState>} */
  const filled = {};
  for (const [id, state] of Object.entries(composers)) {
    if (state.started || state.agentId !== agentId || state.configOptions.length) continue;
    filled[id] = {
      ...state,
      configOptions: options.map((o) => (o.id in state.chosen ? { ...o, currentValue: state.chosen[o.id] } : o)),
    };
  }
  if (Object.keys(filled).length) $composers.set({ ...composers, ...filled });
}
