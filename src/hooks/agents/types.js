/** @typedef {import('../composer/types.js').AcpConfigOption} AcpConfigOption */
/** @typedef {import('../composer/types.js').ConfigOption} ConfigOption */
/**
 * A project's agent that runs what its agents.json chose, waiting for the user's trust
 * (`agents_untrusted`).
 * @typedef {Object} UntrustedAgent
 * @property {string} name
 * @property {LaunchConfig} launch
 */

/**
 * What the trust dialog asks about: the project's agents waiting for trust.
 * @typedef {Object} TrustPrompt
 * @property {string} projectPath
 * @property {UntrustedAgent[]} agents
 */

/**
 * What a session start runs, as the user trusts it (`agents_trust`): the agent's command line and
 * env templates, and the MCP servers it's told to start.
 * @typedef {Object} LaunchConfig
 * @property {string} agentId
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {unknown[]} mcpServers
 */

/**
 * A session's agent asks for a sign-in (the `sign-in` session event).
 * @typedef {Object} SessionSignIn
 * @property {string} agentId
 * @property {string} agentName
 * @property {SignInMethod[]} methods
 */

/**
 * A sign-in this window started or saw (`agents://sign-in`), until it's done or cancelled.
 * @typedef {Object} SignInRun
 * @property {'waiting' | 'failed'} state
 * @property {string | null} message `failed`: why.
 * @property {LoginTab | null} terminal The login's terminal, for a terminal method.
 */

/**
 * `agents://sign-in`: how a sign-in goes.
 * @typedef {Object} SignInEvent
 * @property {string | null} projectPath `null`: the user's agents.
 * @property {string} agentId
 * @property {'waiting' | 'done' | 'failed' | 'cancelled'} state
 * @property {string | null} message `done`: "Signed in to …"; `failed`: why.
 * @property {LoginTab | null} terminal The login's terminal, for a terminal method.
 */

/**
 * An agent as `agents_list` shows it: no environment.
 * @typedef {Object} AgentSummary
 * @property {string} id
 * @property {string} name
 * @property {'user' | 'project'} scope The agents.json that chose what it runs.
 * @property {string | null} version The version installed: the one its args pin, else `agentInfo.version`
 *   from its last `initialize`.
 * @property {string | null} registryId The ACP registry entry it runs; `null`: a custom agent.
 * @property {AgentUpdate | null} update A newer version the registry has.
 * @property {boolean} enabled Not turned off by the user; only these are offered and started.
 * @property {boolean} signIn It asked to sign in and hasn't since.
 * @property {string} command What it runs, for the edit form.
 * @property {string[]} args
 * @property {AgentTerminal | null} [terminal] Its CLI, for a session's Terminal view; `null`: it has none.
 */

/**
 * What an agent's CLI can do for a session's Terminal view.
 * @typedef {Object} AgentTerminal
 * @property {boolean} resume It continues a session by its ACP id.
 * @property {boolean} new It starts a session under an id Brama chooses.
 */

/**
 * A newer version of an agent in the ACP registry.
 * @typedef {Object} AgentUpdate
 * @property {string} to
 * @property {boolean} pin The installed version isn't known: Update pins the registry's ("Pin latest").
 */

/** @typedef {'all' | 'updates' | 'off'} AgentsFilter The Agents tab's filter chip. */

/**
 * What the Agents tab asks the backend for (`agents_view`). In memory.
 * @typedef {Object} AgentsQuery
 * @property {string} query
 * @property {AgentsFilter} filter
 */

/**
 * One of an agent's ways to sign in (ACP `authMethods`). `agent`: the agent signs in itself (it
 * opens the browser); `terminal` / `command`: a login runs in a Terminal tab.
 * @typedef {Object} SignInMethod
 * @property {string} id
 * @property {string} name
 * @property {string | null} description
 * @property {'agent' | 'terminal' | 'command'} kind
 * @property {string | null} label The login terminal's title.
 * @property {{ provider: string | null } | null} apiKey It reads a key from the agent's environment.
 */

/**
 * What a probe learned (`agents_probe_options`): the agent's options, or that it asks to sign in first.
 * @typedef {AcpConfigOption[] | { signIn: SignInMethod[] }} ProbedOptions
 */

/**
 * A sign-in's login running in a terminal the backend started (`agents_sign_in` of a `terminal` /
 * `command` method): exit 0 signs in, closing its tab cancels.
 * @typedef {Object} LoginTab
 * @property {string} terminalId
 * @property {string} title The method's label, else its name.
 * @property {string} commandLine What it runs, without its environment: the tab's tooltip.
 */

/**
 * An agent that asked to sign in, or is signing in.
 * @typedef {Object} AgentSignIn
 * @property {SignInMethod[]} methods
 * @property {boolean} pending A sign-in runs.
 */

/**
 * An installed agent as the Agents tab shows it.
 * @typedef {Object} AgentRow
 * @property {string} id
 * @property {string} name
 * @property {'user' | 'project'} scope
 * @property {boolean} enabled
 * @property {boolean} isDefault
 * @property {string} command
 * @property {string[]} args
 * @property {string | null} version
 * @property {AgentUpdate | null} update
 * @property {boolean} updating An update runs: from its write to the end of its download.
 * @property {'ready' | 'notStarted' | 'off' | 'signIn'} status
 * @property {AgentSignIn | null} signIn With status `signIn`.
 * @property {[number, number][]} nameMatches Where the search matched the name, `[start, end)` in UTF-16 units.
 * @property {AgentTerminal | null} terminal Its CLI, for a session's Terminal view; `null`: it has none.
 * @property {string | null} description The registry's description of what it runs.
 */

/**
 * A registry agent that isn't installed.
 * @typedef {Object} RegistryRow
 * @property {string} id
 * @property {string} name
 * @property {string} vendor
 * @property {string} description
 * @property {string} commandLine What Add writes.
 * @property {[number, number][]} nameMatches
 */

/**
 * The last check of the ACP registry.
 * @typedef {Object} RegistryState
 * @property {string | null} checkedAt ISO 8601; `null`: never, the bundled list is in use.
 * @property {boolean} offline The last check failed.
 * @property {boolean} checking
 */

/**
 * `agents_view`: the Agents tab's data, searched and filtered by the backend.
 * @typedef {Object} AgentsView
 * @property {AgentRow[]} installed
 * @property {AgentRow[]} userAgents With a project: the user's own agents it lacks (All only).
 * @property {RegistryRow[]} registry Registry agents not installed (All only).
 * @property {{ all: number, updates: number, off: number }} counts Ignore the search.
 * @property {string | null} defaultAgent
 * @property {string[]} errors
 * @property {RegistryState} registryState
 */

/**
 * What the Agents tab is to show once open: the registry's agents to add, or an agent's row.
 * @typedef {Object} AgentsReveal
 * @property {boolean} [add]
 * @property {string} [agentId]
 */

/**
 * An ACP registry agent the add form offers, with its pinned `npx` launch.
 * @typedef {Object} KnownAgent
 * @property {string} id Its registry id, also its id in agents.json when that's free.
 * @property {string} name
 * @property {string} command
 * @property {string[]} args
 */

/**
 * An ACP agent added in Settings (`agents_add`), written to the user's agents.json. A `known` one
 * runs its registry launch unless `command` replaces it.
 * @typedef {Object} NewAgent
 * @property {string} name
 * @property {string} [known] A `KnownAgent` id.
 * @property {string} [command]
 * @property {string[]} [args]
 */

/**
 * `agents_list`: the agents configured for a project, the disabled too.
 * @typedef {Object} AgentList
 * @property {AgentSummary[]} agents
 * @property {string | null} defaultAgent
 * @property {KnownAgent[]} known The well-known agents Settings offers to add.
 * @property {AgentSummary[]} userAgents With a project open: the user's own agents it lacks, which apply only
 *   with no project open; Settings offers to copy them in.
 * @property {string[]} errors Files that don't parse (`file:line:column: message`); their last valid version is used.
 */

/**
 * An agent the composer can start a session with; Brama's list, not ACP's.
 * @typedef {Object} AgentInfo
 * @property {string} id
 * @property {string} name
 * @property {boolean} [removed] No longer in agents.json (a started session's).
 * @property {boolean} [off] Turned off by the user: not offered, not started.
 * @property {boolean} [signIn] It asked to sign in: offered still, since picking it is how one signs in.
 */

/** @typedef {'loading' | 'failed'} AgentOptionsStatus Asking an agent for its config options (a probe), or that failed. */

/** @typedef {AgentInfo & { configOptions: ConfigOption[] }} CatalogAgent An agent with its config options as last seen. */

export {};
