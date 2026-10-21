import {
  agentsAdd,
  agentsConfigFile,
  agentsImportUser,
  agentsList,
  agentsProbeOptions,
  agentsRemove,
  agentsRestore,
  agentsSetDefault,
  agentsUpdate,
  onAgentsChanged,
} from './ipc.js';
import { log } from './logger.js';
import { reportError } from './notices.js';
import { $agentList } from '../stores/agents.js';
import { notify } from '../stores/notices.js';
import { cacheAgentOptions, hasAgentOptions } from '../stores/composer.js';
import { openTab } from '../stores/editor.js';
import { $workspacePath } from '../stores/workspace.js';

/** @typedef {import('../models/types.js').NewAgent} NewAgent */

/** How long a removed agent's Undo stays offered, in ms. */
const UNDO_MS = 8000;

/**
 * Keeps `$agentList` on the open project's agents, re-read when an agents.json changes, asks each
 * agent whose models aren't known yet for them, and adds, switches and edits agents for Settings.
 */
export class AgentConfig {
  /** Sequence of loads; only the latest answer is kept. */
  #load = 0;
  /** @type {Set<string>} Agents asked this launch (a failed probe isn't retried until the next). */
  #probed = new Set();
  /** Probes run one at a time: each starts an agent process. */
  #probing = Promise.resolve();

  /** Follows the open project: loads its agents now and when an agents.json changes. */
  start() {
    $workspacePath.subscribe((path) => this.#refresh(path));
    onAgentsChanged((projectPath) => {
      // `null`: the user's file, which every project merges.
      if (projectPath === null || projectPath === $workspacePath.get()) this.#refresh($workspacePath.get());
    }).catch((err) => reportError('Watching agents.json failed', err));
  }

  /**
   * Learns an agent's options by starting it briefly; a failure (not installed, not signed in) only
   * leaves its menu without models until its first session.
   * @param {string | null} projectPath
   * @param {string} agentId
   */
  #probe(projectPath, agentId) {
    this.#probed.add(agentId);
    this.#probing = this.#probing.then(async () => {
      try {
        cacheAgentOptions(agentId, await agentsProbeOptions(projectPath, agentId));
        // The probe learned the agent's version.
        this.refresh();
      } catch (err) {
        log('info', `couldn't ask ${agentId} for its options: ${err}`);
      }
    });
  }

  /** Opens the project's agents.json (the user's without a project) in a tab, creating it if missing. */
  async openFile() {
    try {
      openTab(await agentsConfigFile($workspacePath.get()));
    } catch (err) {
      reportError('Opening agents.json failed', err);
    }
  }

  /**
   * Adds an ACP agent to the open project's agents.json (the user's without a project); the list
   * follows through `agents://changed`.
   * @param {NewAgent} agent
   * @returns {Promise<string>} Its id; rejects with the reason it wasn't added.
   */
  async add(agent) {
    const id = await agentsAdd($workspacePath.get(), agent);
    log('info', `agent ${id} added`);
    return id;
  }

  /**
   * Rewrites an agent from Settings' edit form; the list follows through `agents://changed`.
   * @param {string} agentId
   * @param {NewAgent} agent
   * @returns {Promise<void>} Rejects with the reason it wasn't saved.
   */
  async update(agentId, agent) {
    await agentsUpdate($workspacePath.get(), agentId, agent);
  }

  /** @param {string} agentId */
  async setDefault(agentId) {
    try {
      await agentsSetDefault($workspacePath.get(), agentId);
    } catch (err) {
      reportError('Setting the default agent failed', err);
    }
  }

  /**
   * Removes an agent at once, with Undo on the snackbar that says so.
   * @param {string} agentId
   */
  async remove(agentId) {
    const name = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? agentId;
    try {
      const { token } = await agentsRemove($workspacePath.get(), agentId);
      notify('info', `${name} removed`, {
        timeout: UNDO_MS,
        action: {
          label: 'Undo',
          run: () => agentsRestore(token).catch((err) => reportError(`Restoring ${name} failed`, err)),
        },
      });
    } catch (err) {
      reportError(`Removing ${name} failed`, err);
    }
  }

  /** Copies the user's own agents into the open project's agents.json; the list follows. */
  async importUserAgents() {
    const projectPath = $workspacePath.get();
    if (projectPath === null) return;
    try {
      const ids = await agentsImportUser(projectPath);
      log('info', `agents added to the project: ${ids.join(', ')}`);
    } catch (err) {
      reportError('Adding your agents to the project failed', err);
    }
  }

  /** Re-reads the open project's agents (versions an agent reported since, too). */
  refresh() {
    this.#refresh($workspacePath.get());
  }

  /** @param {string | null} projectPath */
  async #refresh(projectPath) {
    const load = ++this.#load;
    try {
      const list = await agentsList(projectPath);
      if (load !== this.#load) return;
      $agentList.set(list);
      for (const { id } of list.agents) {
        if (!hasAgentOptions(id) && !this.#probed.has(id)) this.#probe(projectPath, id);
      }
    } catch (err) {
      reportError('Loading agents failed', err);
    }
  }
}

/** The app's one `AgentConfig`. */
export const agentConfig = new AgentConfig();
