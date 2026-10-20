import { agentsTrust, agentsUntrusted, onAgentsChanged } from './ipc.js';
import { reportError } from './notices.js';
import { sessionController } from './session-controller.js';
import { $awaitingTrust, $trustPrompt, takeAwaitingTrust } from '../stores/trust.js';
import { projectOf } from '../stores/sessions.js';
import { $workspacePath } from '../stores/workspace.js';
import { trustKey } from '../models/trust.js';

/** @typedef {import('../models/types.js').TrustPrompt} TrustPrompt */

/**
 * Asks the user to trust what the open project's agents.json runs: when the project opens, when the
 * file changes, and when a session's agent start is refused for want of trust.
 */
export class TrustController {
  /** Sequence of checks; only the latest answer is kept. */
  #check = 0;
  /** @type {Set<string>} Prompts answered "Not now" this launch (`trustKey()`); asked again only by a refused start. */
  #dismissed = new Set();

  /** Follows the open project and the sessions refused for want of trust. */
  start() {
    $workspacePath.subscribe((path) => this.#refresh(path, false));
    onAgentsChanged((projectPath) => {
      if (projectPath === null || projectPath === $workspacePath.get()) this.#refresh($workspacePath.get(), false);
    }).catch((err) => reportError('Watching agents.json failed', err));
    $awaitingTrust.listen((waiting) => {
      const projectPath = waiting.length ? projectOf(waiting[waiting.length - 1]) : null;
      if (projectPath !== null && $trustPrompt.get()?.projectPath !== projectPath) this.#refresh(projectPath, true);
    });
  }

  /**
   * @param {string | null} projectPath
   * @param {boolean} force Asks even after "Not now".
   */
  async #refresh(projectPath, force) {
    const check = ++this.#check;
    if (projectPath === null) {
      $trustPrompt.set(null);
      return;
    }
    try {
      const agents = await agentsUntrusted(projectPath);
      if (check !== this.#check) return;
      /** @type {TrustPrompt} */
      const prompt = { projectPath, agents };
      const ask = agents.length > 0 && (force || !this.#dismissed.has(trustKey(prompt)));
      $trustPrompt.set(ask ? prompt : null);
    } catch (err) {
      reportError('Checking the project’s agents failed', err);
    }
  }

  /** Trusts what the prompt showed and starts the project's sessions it held back. */
  async trust() {
    const prompt = $trustPrompt.get();
    if (!prompt) return;
    $trustPrompt.set(null);
    try {
      await agentsTrust(prompt.projectPath, prompt.agents.map((a) => a.launch));
    } catch (err) {
      reportError('Trusting the project failed', err);
      this.#refresh(prompt.projectPath, true);
      return;
    }
    for (const id of takeAwaitingTrust(prompt.projectPath)) sessionController.restart(id);
  }

  /** "Not now": asked again when what it runs changes, or when a session's start is refused. */
  dismiss() {
    const prompt = $trustPrompt.get();
    if (!prompt) return;
    this.#dismissed.add(trustKey(prompt));
    $trustPrompt.set(null);
    takeAwaitingTrust(prompt.projectPath);
  }
}

/** The app's one `TrustController`. */
export const trustController = new TrustController();
