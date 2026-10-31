import { $agentList, $agentsPending, $agentsQuery, $agentsView, noteSignIn, whileUpdating } from '../../stores/agents/agents.js';
import { notify } from '../../stores/notices/notices.js';
import { cacheAgentOptions, hasAgentOptions, whileLoadingOptions } from '../../stores/composer/composer.js';
import { openAgents, openTab } from '../../stores/editor/editor.js';
import { openLoginTerminal } from '../../stores/terminals/terminals.js';
import { $workspacePath } from '../../stores/workspace/workspace.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import {
  agentBrandOf,
  commandLine,
  isAgentsFile,
  isUserAgentsFile,
  ownSignIns,
  parseCommandLine,
  signInAfterAdd,
  trustConfirm,
} from './rules.js';
import { dismissTrust, startTrust, trust, trustOnChanged } from './trust.js';

/** @typedef {import('../../models/types/types.js').NewAgent} NewAgent */
/** @typedef {import('../../models/types/types.js').AgentList} AgentList */
/** @typedef {import('../../models/types/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../models/types/types.js').AgentsView} AgentsView */
/** @typedef {import('../../models/types/types.js').ProbedOptions} ProbedOptions */
/** @typedef {import('../../models/types/types.js').LoginTab} LoginTab */
/** @typedef {import('../../models/types/types.js').SignInEvent} SignInEvent */
/** @typedef {import('./rules.js').AgentBrand} AgentBrand */

/** How long a removed agent's Undo stays offered, in ms. */
const UNDO_MS = 8000;

/** Sequence of loads; only the latest answer is kept. */
let load = 0;
/** Sequence of `agents_view` calls; only the latest answer is kept. */
let searches = 0;
/** @type {Map<string, Promise<ProbedOptions | null>>} Agents asked this launch (a failed probe, `null`, isn't retried until the next). */
const probed = new Map();
/** @type {Promise<unknown>} Probes run one at a time: each starts an agent process. */
let probing = Promise.resolve();

/** @param {string} agentId */
function nameOf(agentId) {
  return $agentList.get().agents.find((a) => a.id === agentId)?.name ?? agentId;
}

/** @param {string | null} projectPath */
async function refresh(projectPath) {
  const current = ++load;
  try {
    /** @type {AgentList} */
    const list = await ipc.invoke('agents_list', { projectPath });
    if (current !== load) return;
    $agentList.set(list);
    for (const { id } of list.agents) {
      if (!hasAgentOptions(id) && !probed.has(id)) probe(projectPath, id);
    }
  } catch (err) {
    app.reportError('Loading agents failed', err);
  }
}

/**
 * Learns an agent's options by starting it briefly; a failure (not installed, not signed in) only
 * leaves its menu without models until its first session.
 * @param {string | null} projectPath
 * @param {string} agentId
 * @param {boolean} [now] Don't wait for the other probes: the user waits for this one.
 */
function probe(projectPath, agentId, now = false) {
  /** @type {Promise<ProbedOptions | null>} */
  const asked = (now ? Promise.resolve() : probing).then(async () => {
    /** @type {ProbedOptions | null} */
    let options = null;
    await whileLoadingOptions(agentId, async () => {
      try {
        options = await ipc.invoke('agents_probe_options', { projectPath, agentId });
      } catch (err) {
        app.log('info', `couldn't ask ${agentId} for its options: ${err}`);
        return false;
      }
      if (Array.isArray(options)) cacheAgentOptions(agentId, options);
      return true;
    });
    // The probe learned the agent's version, or that it needs a sign-in: the picker and the
    // Agents tab's row say so.
    if (options !== null) {
      agents.refresh();
      agents.search();
    }
    return options;
  });
  probed.set(agentId, asked);
  if (!now) probing = asked;
  return asked;
}

/**
 * @template T
 * @param {string} event
 * @param {string} failure What the snackbar says when it can't be heard.
 * @param {(payload: T) => void} handler
 * @returns {() => void} Stops listening.
 */
function listen(event, failure, handler) {
  const listening = ipc.listen(event, handler).catch((err) => {
    app.reportError(failure, err);
    return () => {};
  });
  return () => void listening.then((off) => off()).catch(() => {});
}

/**
 * @param {(() => void)[]} stops
 * @returns {() => void} Calls them all.
 */
function unlistenAll(stops) {
  return () => stops.forEach((stop) => stop());
}

/**
 * Probes an agent just added at once (unless the list's reload already does) and says it was
 * added, with Sign in when it asks for that first.
 * @param {string | null} projectPath
 * @param {string} agentId
 */
async function announceAdded(projectPath, agentId) {
  const options = await (probed.get(agentId) ?? probe(projectPath, agentId));
  const name = nameOf(agentId);
  const signIn = options && signInAfterAdd(options);
  if (!signIn) {
    notify('info', `${name} added`);
    return;
  }
  notify('info', `${name} added · Sign in to use it`, {
    action: {
      label: 'Sign in',
      run: () => (signIn.methodId ? agents.signIn(agentId, signIn.methodId) : openAgents({ agentId })),
    },
  });
}

/**
 * The agents of the open project: `$agentList` for the composer, `$agentsView` for the Agents tab,
 * each agent's options, adding, editing, updating and signing in, and the trust the project's
 * agents.json needs. Also the rules about agents, their command lines and agents.json files.
 */
export const agents = Object.freeze({
  agentBrandOf,
  commandLine,
  parseCommandLine,
  ownSignIns,
  isAgentsFile,
  isUserAgentsFile,
  trustConfirm,

  /**
   * Follows the open project: loads its agents now and when an agents.json changes, and asks to
   * trust what its agents.json runs.
   * @returns {() => void} Stops following (tests; the app follows for its life).
   */
  start() {
    return unlistenAll([
      $workspacePath.subscribe((path) => {
        refresh(path);
        agents.search();
      }),
      startTrust(),
      listen('agents://changed', 'Watching agents.json failed', (/** @type {{ projectPath: string | null }} */ { projectPath }) => {
        // `null`: the user's file, which every project merges, or the registry.
        if (projectPath === null || projectPath === $workspacePath.get()) {
          refresh($workspacePath.get());
          agents.search();
        }
        trustOnChanged(projectPath);
      }),
      listen('agents://sign-in', 'Watching sign-ins failed', (/** @type {SignInEvent} */ event) => {
        noteSignIn(event);
        if (event.state === 'done' && event.message) notify('info', event.message);
        // Its row and the picker say "Needs sign-in" until it's signed in.
        if (event.projectPath === $workspacePath.get()) {
          agents.search();
          agents.refresh();
        }
      }),
    ]);
  },

  trust,
  dismissTrust,

  /**
   * Signs an agent of the open project in (`methodId: null` only checks); `agents://sign-in` says how it goes.
   * @param {string} agentId
   * @param {string | null} methodId
   */
  async signIn(agentId, methodId) {
    const projectPath = $workspacePath.get();
    try {
      /** @type {LoginTab | null} */
      const login = await ipc.invoke('agents_sign_in', { projectPath, agentId, methodId });
      if (login) openLoginTerminal(login, projectPath);
    } catch (err) {
      app.reportError(`Signing in to ${nameOf(agentId)} failed`, err);
    }
  },

  /** @param {string} agentId */
  async cancelSignIn(agentId) {
    try {
      await ipc.invoke('agents_sign_in_cancel', { projectPath: $workspacePath.get(), agentId });
    } catch (err) {
      app.reportError('Cancelling the sign-in failed', err);
    }
  },

  /**
   * Asks the backend for the Agents tab's data: the search and filter given, else the current ones.
   * An answer that comes after a newer question's is dropped.
   * @param {AgentsQuery} [query]
   */
  async search(query = $agentsQuery.get()) {
    $agentsQuery.set(query);
    const current = ++searches;
    try {
      /** @type {AgentsView} */
      const view = await ipc.invoke('agents_view', { projectPath: $workspacePath.get(), query: query.query, filter: query.filter });
      if (current === searches) $agentsView.set(view);
    } catch (err) {
      if (current === searches) app.reportError('Loading agents failed', err);
    }
  },

  /**
   * Updates an agent to the registry's version; the list shows "Updating…" until its download ends.
   * @param {string} agentId
   */
  async updateVersion(agentId) {
    try {
      await whileUpdating([agentId], () => ipc.invoke('agents_update_version', { projectPath: $workspacePath.get(), agentId }));
    } catch (err) {
      app.reportError(`Updating ${nameOf(agentId)} failed`, err);
    }
    // Its download ended: the backend no longer says it's updating.
    agents.search();
  },

  /** Updates every agent that has an update. */
  async updateAll() {
    const ids = ($agentsView.get()?.installed ?? []).filter((a) => a.update).map((a) => a.id);
    try {
      await whileUpdating(ids, () => ipc.invoke('agents_update_all', { projectPath: $workspacePath.get() }));
    } catch (err) {
      app.reportError('Updating agents failed', err);
    }
    agents.search();
  },

  /** Asks the ACP registry now; the tab shows the answer. */
  async checkRegistry() {
    $agentsPending.set({ ...$agentsPending.get(), checking: true });
    try {
      await ipc.invoke('agents_registry_check');
    } catch (err) {
      app.reportError('Checking the ACP registry failed', err);
    }
    $agentsPending.set({ ...$agentsPending.get(), checking: false });
    agents.search();
  },

  /**
   * Asks an agent the user just picked for its options, once per launch, ahead of the probes
   * queued at launch; the model picker shows it loading meanwhile.
   * @param {string} agentId
   */
  loadOptions(agentId) {
    return probed.get(agentId) ?? probe($workspacePath.get(), agentId, true);
  },

  /** Opens the project's agents.json (the user's without a project) in a tab, creating it if missing. */
  async openFile() {
    try {
      openTab(await ipc.invoke('agents_config_file', { projectPath: $workspacePath.get() }));
    } catch (err) {
      app.reportError('Opening agents.json failed', err);
    }
  },

  /**
   * Adds an ACP agent to the open project's agents.json (the user's without a project); the list
   * follows through `agents://changed`.
   * @param {NewAgent} agent
   * @returns {Promise<string>} Its id; rejects with the reason it wasn't added.
   */
  async add(agent) {
    const projectPath = $workspacePath.get();
    /** @type {string} */
    const id = await ipc.invoke('agents_add', { projectPath, agent });
    app.log('info', `agent ${id} added`);
    announceAdded(projectPath, id);
    return id;
  },

  /**
   * Rewrites an agent from Settings' edit form; the list follows through `agents://changed`.
   * @param {string} agentId
   * @param {NewAgent} agent
   * @returns {Promise<void>} Rejects with the reason it wasn't saved.
   */
  async update(agentId, agent) {
    await ipc.invoke('agents_update', { projectPath: $workspacePath.get(), agentId, agent });
  },

  /** @param {string} agentId */
  async setDefault(agentId) {
    try {
      await ipc.invoke('agents_set_default', { projectPath: $workspacePath.get(), agentId });
    } catch (err) {
      app.reportError('Setting the default agent failed', err);
    }
  },

  /**
   * Turns an agent on or off for this user; turning it off stops its sessions (after their running
   * turns), which the snackbar counts.
   * @param {string} agentId
   * @param {boolean} enabled
   */
  async setEnabled(agentId, enabled) {
    const name = nameOf(agentId);
    try {
      /** @type {number} */
      const stopped = await ipc.invoke('agents_set_enabled', { projectPath: $workspacePath.get(), agentId, enabled });
      if (stopped > 0) notify('info', `${name} off · ${stopped} ${stopped === 1 ? 'session' : 'sessions'} stopped`);
    } catch (err) {
      app.reportError(`Turning ${name} ${enabled ? 'on' : 'off'} failed`, err);
    }
  },

  /**
   * Removes an agent at once, with Undo on the snackbar that says so.
   * @param {string} agentId
   */
  async remove(agentId) {
    const name = nameOf(agentId);
    try {
      /** @type {{ token: number }} */
      const { token } = await ipc.invoke('agents_remove', { projectPath: $workspacePath.get(), agentId });
      // Added again, it's probed again.
      probed.delete(agentId);
      notify('info', `${name} removed`, {
        timeout: UNDO_MS,
        action: {
          label: 'Undo',
          run: () => ipc.invoke('agents_restore', { token }).catch((err) => app.reportError(`Restoring ${name} failed`, err)),
        },
      });
    } catch (err) {
      app.reportError(`Removing ${name} failed`, err);
    }
  },

  /**
   * Copies the user's own agents into the open project's agents.json; the list follows.
   * @param {string[] | null} [agentIds] Only these; `null`: all of them.
   */
  async importUserAgents(agentIds = null) {
    const projectPath = $workspacePath.get();
    if (projectPath === null) return;
    try {
      /** @type {string[]} */
      const ids = await ipc.invoke('agents_import_user', { projectPath, agentIds });
      app.log('info', `agents added to the project: ${ids.join(', ')}`);
    } catch (err) {
      app.reportError('Adding your agents to the project failed', err);
    }
  },

  /** Re-reads the open project's agents (versions an agent reported since, too). */
  refresh() {
    refresh($workspacePath.get());
  },
});
