/**
 * An ACP `SessionConfigOption` as the agent sent it (`config-options` events); see
 * `normalizeOptions()` for what the composer keeps.
 * @typedef {{ id: string, name: string, type: string, category?: string, currentValue?: unknown,
 *   options?: unknown[] }} AcpConfigOption
 */

/**
 * How much a mode lets the agent do without asking (`plan`: changes nothing; `neutral`: asks;
 * `agent`: edits on its own; `full`: anything). The backend tags an agent's mode values with it (its
 * crate's `Agent::mode_risk`): the page never names an agent's modes.
 * @typedef {'plan' | 'neutral' | 'agent' | 'full'} ModeRisk
 */

/**
 * One value of an ACP session config option.
 * @typedef {Object} ConfigOptionValue
 * @property {string} value
 * @property {string} name
 * @property {string} [description]
 * @property {ModeRisk} [risk] A mode value's, when its agent's crate knows it.
 */

/**
 * An ACP session config option (`configOptions` of `session/new`, `config_option_update`), kept in
 * the agent's order. The composer finds its controls by `category`.
 * @typedef {Object} ConfigOption
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {'model' | 'thought_level' | 'mode' | string} [category]
 * @property {'select'} type
 * @property {string} currentValue
 * @property {ConfigOptionValue[]} options
 */

/**
 * Where a session runs (`Session.mode`): its project's folder or a worktree.
 * @typedef {'local' | 'worktree' | 'docker'} RunTargetKind
 */

/**
 * Where a draft's first message creates its chat: the worktree workspace it's a draft of, a new
 * worktree workspace from `base` (`null`: Main's default branch), or Main (Local).
 * @typedef {{ kind: 'workspace' } | { kind: 'worktree', base: string | null } | { kind: 'local' }} RunTarget
 */

/**
 * The agent composer's state for the chat (`$composer`).
 * @typedef {Object} ComposerState
 * @property {string | null} agentId `null` while the project configures no agent; a started session's is set.
 * @property {ConfigOption[]} configOptions The agent's, as it last reported them (shown with `chosen` applied).
 * @property {Record<string, string>} chosen Values the user picked that the agent hasn't confirmed yet
 *   (picked before it started, or on their way), by config option id.
 * @property {RunTarget} [runTarget] A draft's place, once picked; until then its workspace's
 *   (`composer.runTargetOf()`).
 * @property {boolean} started After the first message: the agent is fixed.
 */

export {};
