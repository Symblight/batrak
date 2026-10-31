import {
  agentsAdd,
  agentsConfigFile,
  agentsImportUser,
  agentsList,
  agentsProbeOptions,
  agentsRegistryCheck,
  agentsRemove,
  agentsRestore,
  agentsSetDefault,
  agentsSetEnabled,
  agentsSignIn,
  agentsSignInCancel,
  agentsUpdate,
  agentsUpdateAll,
  agentsUpdateVersion,
  agentsView,
  onAgentsChanged,
  onAgentsSignIn,
} from '../ipc/ipc.js';
import { log } from '../logger/logger.js';
import { reportError } from '../notices/notices.js';
import { signInAfterAdd } from '../../models/agents/agents.js';
import { $agentList, $agentsPending, $agentsQuery, $agentsView, noteSignIn, whileUpdating } from '../../stores/agents/agents.js';
import { notify } from '../../stores/notices/notices.js';
import { cacheAgentOptions, hasAgentOptions, whileLoadingOptions } from '../../stores/composer/composer.js';
import { openAgents, openTab } from '../../stores/editor/editor.js';
import { openLoginTerminal } from '../../stores/terminals/terminals.js';
import { $workspacePath } from '../../stores/workspace/workspace.js';

/** @typedef {import('../../models/types/types.js').NewAgent} NewAgent */
/** @typedef {import('../../models/types/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../models/types/types.js').ProbedOptions} ProbedOptions */

/** How long a removed agent's Undo stays offered, in ms. */
const UNDO_MS = 8000;

/**
 * Keeps `$agentList` on the open project's agents, re-read when an agents.json changes, asks each
 * agent whose models aren't known yet for them, and adds, switches and edits agents for Settings.
 */
export class AgentConfig {
  /** Sequence of loads; only the latest answer is kept. */
  #load = 0;
  /** Sequence of `agents_view` calls; only the latest answer is kept. */
  #search = 0;
  /** @type {Map<string, Promise<ProbedOptions | null>>} Agents asked this launch (a failed probe, `null`, isn't retried until the next). */
  #probed = new Map();
  /** @type {Promise<unknown>} Probes run one at a time: each starts an agent process. */
  #probing = Promise.resolve();

  /** Follows the open project: loads its agents now and when an agents.json changes. */
  start() {
    $workspacePath.subscribe((path) => {
      this.#refresh(path);
      this.search();
    });
    onAgentsChanged((projectPath) => {
      // `null`: the user's file, which every project merges, or the registry.
      if (projectPath === null || projectPath === $workspacePath.get()) {
        this.#refresh($workspacePath.get());
        this.search();
      }
    }).catch((err) => reportError('Watching agents.json failed', err));
    onAgentsSignIn((event) => {
      noteSignIn(event);
      if (event.state === 'done' && event.message) notify('info', event.message);
      // Its row and the picker say "Needs sign-in" until it's signed in.
      if (event.projectPath === $workspacePath.get()) {
        this.search();
        this.refresh();
      }
    }).catch((err) => reportError('Watching sign-ins failed', err));
  }

  /**
   * Signs an agent of the open project in (`methodId: null` only checks); `agents://sign-in` says how it goes.
   * @param {string} agentId
   * @param {string | null} methodId
   */
  async signIn(agentId, methodId) {
    const projectPath = $workspacePath.get();
    try {
      const login = await agentsSignIn(projectPath, agentId, methodId);
      if (login) openLoginTerminal(login, projectPath);
    } catch (err) {
      reportError(`Signing in to ${this.#nameOf(agentId)} failed`, err);
    }
  }

  /** @param {string} agentId */
  async cancelSignIn(agentId) {
    try {
      await agentsSignInCancel($workspacePath.get(), agentId);
    } catch (err) {
      reportError('Cancelling the sign-in failed', err);
    }
  }

  /**
   * Asks the backend for the Agents tab's data: the search and filter given, else the current ones.
   * An answer that comes after a newer question's is dropped.
   * @param {AgentsQuery} [query]
   */
  async search(query = $agentsQuery.get()) {
    $agentsQuery.set(query);
    const search = ++this.#search;
    try {
      const view = await agentsView($workspacePath.get(), query.query, query.filter);
      if (search === this.#search) $agentsView.set(view);
    } catch (err) {
      if (search === this.#search) reportError('Loading agents failed', err);
    }
  }

  /**
   * Updates an agent to the registry's version; the list shows "Updating…" until its download ends.
   * @param {string} agentId
   */
  async updateVersion(agentId) {
    try {
      await whileUpdating([agentId], () => agentsUpdateVersion($workspacePath.get(), agentId));
    } catch (err) {
      reportError(`Updating ${this.#nameOf(agentId)} failed`, err);
    }
    // Its download ended: the backend no longer says it's updating.
    this.search();
  }

  /** Updates every agent that has an update. */
  async updateAll() {
    const ids = ($agentsView.get()?.installed ?? []).filter((a) => a.update).map((a) => a.id);
    try {
      await whileUpdating(ids, () => agentsUpdateAll($workspacePath.get()));
    } catch (err) {
      reportError('Updating agents failed', err);
    }
    this.search();
  }

  /** Asks the ACP registry now; the tab shows the answer. */
  async checkRegistry() {
    $agentsPending.set({ ...$agentsPending.get(), checking: true });
    try {
      await agentsRegistryCheck();
    } catch (err) {
      reportError('Checking the ACP registry failed', err);
    }
    $agentsPending.set({ ...$agentsPending.get(), checking: false });
    this.search();
  }

  /** @param {string} agentId */
  #nameOf(agentId) {
    return $agentList.get().agents.find((a) => a.id === agentId)?.name ?? agentId;
  }

  /**
   * Asks an agent the user just picked for its options, once per launch, ahead of the probes
   * queued at launch; the model picker shows it loading meanwhile.
   * @param {string} agentId
   */
  loadOptions(agentId) {
    return this.#probed.get(agentId) ?? this.#probe($workspacePath.get(), agentId, true);
  }

  /**
   * Learns an agent's options by starting it briefly; a failure (not installed, not signed in) only
   * leaves its menu without models until its first session.
   * @param {string | null} projectPath
   * @param {string} agentId
   * @param {boolean} [now] Don't wait for the other probes: the user waits for this one.
   */
  #probe(projectPath, agentId, now = false) {
    /** @type {Promise<ProbedOptions | null>} */
    const probe = (now ? Promise.resolve() : this.#probing).then(async () => {
      /** @type {ProbedOptions | null} */
      let probed = null;
      await whileLoadingOptions(agentId, async () => {
        try {
          probed = await agentsProbeOptions(projectPath, agentId);
        } catch (err) {
          log('info', `couldn't ask ${agentId} for its options: ${err}`);
          return false;
        }
        if (Array.isArray(probed)) cacheAgentOptions(agentId, probed);
        return true;
      });
      // The probe learned the agent's version, or that it needs a sign-in: the picker and the
      // Agents tab's row say so.
      if (probed !== null) {
        this.refresh();
        this.search();
      }
      return probed;
    });
    this.#probed.set(agentId, probe);
    if (!now) this.#probing = probe;
    return probe;
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
    const projectPath = $workspacePath.get();
    const id = await agentsAdd(projectPath, agent);
    log('info', `agent ${id} added`);
    this.#announceAdded(projectPath, id);
    return id;
  }

  /**
   * Probes an agent just added at once (unless the list's reload already does) and says it was
   * added, with Sign in when it asks for that first.
   * @param {string | null} projectPath
   * @param {string} agentId
   */
  async #announceAdded(projectPath, agentId) {
    const probed = await (this.#probed.get(agentId) ?? this.#probe(projectPath, agentId));
    const name = this.#nameOf(agentId);
    const signIn = probed && signInAfterAdd(probed);
    if (!signIn) {
      notify('info', `${name} added`);
      return;
    }
    notify('info', `${name} added · Sign in to use it`, {
      action: {
        label: 'Sign in',
        run: () => (signIn.methodId ? this.signIn(agentId, signIn.methodId) : openAgents({ agentId })),
      },
    });
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
   * Turns an agent on or off for this user; turning it off stops its sessions (after their running
   * turns), which the snackbar counts.
   * @param {string} agentId
   * @param {boolean} enabled
   */
  async setEnabled(agentId, enabled) {
    const name = $agentList.get().agents.find((a) => a.id === agentId)?.name ?? agentId;
    try {
      const stopped = await agentsSetEnabled($workspacePath.get(), agentId, enabled);
      if (stopped > 0) notify('info', `${name} off · ${stopped} ${stopped === 1 ? 'session' : 'sessions'} stopped`);
    } catch (err) {
      reportError(`Turning ${name} ${enabled ? 'on' : 'off'} failed`, err);
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
      // Added again, it's probed again.
      this.#probed.delete(agentId);
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

  /**
   * Copies the user's own agents into the open project's agents.json; the list follows.
   * @param {string[] | null} [agentIds] Only these; `null`: all of them.
   */
  async importUserAgents(agentIds = null) {
    const projectPath = $workspacePath.get();
    if (projectPath === null) return;
    try {
      const ids = await agentsImportUser(projectPath, agentIds);
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
