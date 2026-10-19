import { agentsConfigFile, agentsList, agentsProbeOptions, onAgentsChanged } from './ipc.js';
import { log } from './logger.js';
import { reportError } from './notices.js';
import { $agentList } from '../stores/agents.js';
import { cacheAgentOptions, hasAgentOptions } from '../stores/composer.js';
import { openTab } from '../stores/editor.js';
import { $workspacePath } from '../stores/workspace.js';

/**
 * Keeps `$agentList` on the open project's agents, re-read when an agents.json changes, asks each
 * agent whose models aren't known yet for them, and opens the file to add an agent.
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
