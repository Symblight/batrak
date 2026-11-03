import { atom, computed } from 'nanostores';
import { $activeSessionId, $sessions } from '../sessions/sessions.js';
import { $agentList } from '../agents/agents.js';
import { isRecord, persistentStore } from '../persistent/persistent.js';

/** @typedef {import('../../hooks/composer/types.js').ModeRisk} ModeRisk */
/** @typedef {import('../../hooks/agents/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../hooks/composer/types.js').ConfigOption} ConfigOption */
/** @typedef {import('../../hooks/composer/types.js').ComposerState} ComposerState */
/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

/** @typedef {import('../../hooks/agents/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../../hooks/composer/types.js').AcpConfigOption} AcpConfigOption */

/**
 * Each agent's config options by agent id, so a new session shows the agent's real models and
 * levels before it starts. `currentValue` is the agent's own default as first learned (a probe
 * replaces it), not what some session was switched to. Shared by every window. `:2`: options kept
 * before modes were tagged with their risk aren't read (they'd show a full-access mode as a usual
 * one), so each agent is probed once again.
 */
const $agentOptions = persistentStore(
  'brama:agents:config-options:2',
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
 * @param {string} a
 * @param {string} b
 */
function sameText(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The mode risks the backend tags values with. */
const RISKS = ['plan', 'neutral', 'agent', 'full'];

/**
 * ACP config options as the composer shows them: select options only, groups flattened, each value
 * once, no description that only repeats its name.
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
    const flat = [];
    for (const v of values) {
      // An agent may send a value twice (Copilot's `auto`): the first one stays.
      if (!isRecord(v) || typeof v.value !== 'string' || flat.some((f) => f.value === v.value)) continue;
      const name = typeof v.name === 'string' ? v.name : v.value;
      const described = typeof v.description === 'string' && !sameText(v.description, name) && !sameText(v.description, v.value);
      const risk = typeof v.risk === 'string' && RISKS.includes(v.risk) ? /** @type {ModeRisk} */ (v.risk) : null;
      flat.push({
        value: v.value,
        name,
        ...(described ? { description: /** @type {string} */ (v.description) } : {}),
        ...(risk ? { risk } : {}),
      });
    }
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
 * @param {{ id: string, name: string, enabled?: boolean, signIn?: boolean }} agent
 * @returns {CatalogAgent}
 */
function catalogEntry({ id, name, enabled = true, signIn = false }) {
  return { id, name, configOptions: $agentOptions.get()[id] ?? [], removed: false, off: !enabled, signIn };
}

/** The project's agents (`$agentList`), each with its config options as last seen; `off` ones aren't offered. */
export const $agents = computed([$agentList, $agentOptions], (list) =>
  list.agents.map(catalogEntry),
);

/**
 * An agent of the catalogue; one that isn't configured (any more) shows by its id.
 * @param {string} agentId
 */
function agentOf(agentId) {
  return $agents.get().find((a) => a.id === agentId) ?? catalogEntry({ id: agentId, name: agentId });
}

/**
 * A draft's: the agent's defaults with the user's last picks for it, which are sent when it starts.
 * @param {string | null} agentId `null`: the project configures no agent.
 * @returns {ComposerState}
 */
function freshState(agentId) {
  const options = agentId === null ? [] : agentOf(agentId).configOptions;
  const picks = (agentId !== null && $lastPicks.get()[agentId]) || {};
  // With the options unknown, every pick goes; the backend leaves out what the agent lacks.
  const chosen = options.length
    ? Object.fromEntries(Object.entries(picks).filter(([id, value]) => options.some((o) => o.id === id && offers(o, value))))
    : { ...picks };
  return {
    agentId,
    configOptions: withValues(options, chosen),
    chosen,
    started: false,
  };
}

/**
 * A listed session's before its agent reports (after a reload): its own agent and values.
 * @param {Session} session
 * @returns {ComposerState}
 */
function listedState(session) {
  return {
    agentId: session.agentId,
    configOptions: withValues(agentOf(session.agentId).configOptions, session.config),
    chosen: {},
    started: true,
  };
}

/** The agent last picked; a new session starts with it while it's configured. */
const $lastAgentId = atom(/** @type {string | null} */ (null));

/** The agent a new session starts with: the last picked, else the config's default, else the first, else none. */
const $newSessionAgentId = computed([$lastAgentId, $agentList], (last, list) => {
  const runnable = list.agents.filter((a) => a.enabled).map((a) => a.id);
  if (last !== null && runnable.includes(last)) return last;
  if (list.defaultAgent !== null && runnable.includes(list.defaultAgent)) return list.defaultAgent;
  return runnable[0] ?? null;
});

/** Each session's composer by session id, once it differs from a fresh one. In memory. */
const $composers = atom(/** @type {Readonly<Record<string, ComposerState>>} */ ({}));

/** The active session's composer: agent and its ACP config options. */
export const $composer = computed(
  [$composers, $activeSessionId, $sessions, $newSessionAgentId, $agents, $lastPicks],
  (_composers, id, _sessions, agentId) => (id === null ? freshState(agentId) : composerOf(id)),
);

/**
 * @param {string} id A session's or a draft's.
 * @returns {ComposerState}
 */
export function composerOf(id) {
  const stored = $composers.get()[id];
  // A draft whose agent is gone (none yet, removed from agents.json or turned off since) gets the
  // one a new session would.
  const gone = stored && !stored.started && !$agents.get().some((a) => a.id === stored.agentId && !a.off);
  if (stored && gone && stored.agentId !== $newSessionAgentId.get()) {
    return freshState($newSessionAgentId.get());
  }
  const session = $sessions.get().find((s) => s.id === id);
  // The backend moved the session to another id for its agent (removed and added again).
  if (stored?.started && session && session.agentId !== stored.agentId) {
    return { ...stored, agentId: session.agentId, configOptions: withValues(agentOf(session.agentId).configOptions, session.config) };
  }
  if (stored) return stored;
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

/**
 * @param {string | null} agentId
 * @param {string | null} [knownName] A started session's name for it, shown once agents.json no longer has it.
 * @returns {AgentInfo | null}
 */
export function agentInfo(agentId, knownName = null) {
  if (agentId === null) return null;
  const agent = $agents.get().find((a) => a.id === agentId);
  if (agent) return agent;
  const name = knownName ?? agentId;
  return { id: agentId, name, removed: true };
}

/**
 * Switches agent before the session starts; its config options start from its defaults.
 * @param {string} agentId
 */
export function selectAgent(agentId) {
  const state = $composer.get();
  if (state.started || state.agentId === agentId) return;
  $lastAgentId.set(agentId);
  updateActive(() => freshState(agentId));
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
  if (agentId !== null && option && option.category !== 'mode') {
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
  const refused = agentId !== null ? picks[agentId]?.[configId] : undefined;
  if (agentId !== null && refused !== undefined && refused === pending[configId]) {
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
  if (state.agentId !== null) {
    const known = $agentOptions.get()[state.agentId] ?? [];
    const defaults = Object.fromEntries(known.map((o) => [o.id, o.currentValue]));
    $agentOptions.set({ ...$agentOptions.get(), [state.agentId]: withValues(options, defaults) });
  }
  return Object.entries(chosen).map(([configId, value]) => ({ configId, value }));
}

/**
 * The session's first message went out: its agent is fixed from now on.
 * @param {string} id
 */
export function startComposer(id) {
  updateComposer(id, (state) => (state.started ? state : { ...state, started: true }));
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

/** @typedef {import('../../hooks/agents/types.js').AgentOptionsStatus} AgentOptionsStatus */

/** Agents whose options are being asked for, or whose last ask failed, by agent id. In memory. */
const $agentOptionsStatus = atom(/** @type {Readonly<Record<string, AgentOptionsStatus>>} */ ({}));

/** Whether the composer's agent's options are loading or failed to; `null` once known or not asked. */
export const $composerOptionsStatus = computed([$composer, $agentOptionsStatus], (composer, statuses) =>
  composer.agentId === null ? null : (statuses[composer.agentId] ?? null),
);

/**
 * Shows the agent's options as loading while `load` runs, then as failed unless it resolved `true`.
 * @param {string} agentId
 * @param {() => Promise<boolean>} load Resolves whether the options were learned.
 */
export async function whileLoadingOptions(agentId, load) {
  /** @param {AgentOptionsStatus | null} status */
  const set = (status) => {
    const { [agentId]: _, ...rest } = $agentOptionsStatus.get();
    $agentOptionsStatus.set(status === null ? rest : { ...rest, [agentId]: status });
  };
  set('loading');
  let loaded = false;
  try {
    loaded = await load();
  } finally {
    set(loaded ? null : 'failed');
  }
}
