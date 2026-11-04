import { $awaitingTrust, $trustPrompt, takeAwaitingTrust } from '../../stores/trust/trust.js';
import { projectOf } from '../../stores/sessions/sessions.js';
import { $projectPath } from '../../stores/project/project.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { trustKey } from './rules.js';

/** @typedef {import('./types.js').TrustPrompt} TrustPrompt */
/** @typedef {import('./types.js').UntrustedAgent} UntrustedAgent */

/** Sequence of checks; only the latest answer is kept. */
let check = 0;
/** @type {Set<string>} Prompts answered "Not now" since `startTrust()`, so this launch (`trustKey()`); asked again only by a refused start. */
const dismissed = new Set();

/**
 * @param {string | null} projectPath
 * @param {boolean} force Asks even after "Not now".
 */
async function refresh(projectPath, force) {
  const current = ++check;
  if (projectPath === null) {
    $trustPrompt.set(null);
    return;
  }
  try {
    /** @type {UntrustedAgent[]} */
    const agents = await ipc.invoke('agents_untrusted', { projectPath });
    if (current !== check) return;
    /** @type {TrustPrompt} */
    const prompt = { projectPath, agents };
    const ask = agents.length > 0 && (force || !dismissed.has(trustKey(prompt)));
    $trustPrompt.set(ask ? prompt : null);
  } catch (err) {
    app.reportError('Checking the project’s agents failed', err);
  }
}

/**
 * Asks the user to trust what the open project's agents.json runs: when the project opens, when the
 * file changes (`trustOnChanged()`), and when a session's agent start is refused for want of trust.
 * @returns {() => void} Stops following.
 */
export function startTrust() {
  dismissed.clear();
  const stops = [
    $projectPath.subscribe((path) => refresh(path, false)),
    $awaitingTrust.listen((waiting) => {
      const projectPath = waiting.length ? projectOf(waiting[waiting.length - 1]) : null;
      if (projectPath !== null && $trustPrompt.get()?.projectPath !== projectPath) refresh(projectPath, true);
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

/** @param {string | null} projectPath An agents.json changed: this project's, or the user's (`null`). */
export function trustOnChanged(projectPath) {
  if (projectPath === null || projectPath === $projectPath.get()) refresh($projectPath.get(), false);
}

/**
 * Trusts what the prompt showed.
 * @returns {Promise<string[]>} The project's sessions it held back, to start again.
 */
export async function trust() {
  const prompt = $trustPrompt.get();
  if (!prompt) return [];
  $trustPrompt.set(null);
  try {
    await ipc.invoke('agents_trust', { projectPath: prompt.projectPath, launches: prompt.agents.map((a) => a.launch) });
  } catch (err) {
    app.reportError('Trusting the project failed', err);
    refresh(prompt.projectPath, true);
    return [];
  }
  return takeAwaitingTrust(prompt.projectPath);
}

/** "Not now": asked again when what it runs changes, or when a session's start is refused. */
export function dismissTrust() {
  const prompt = $trustPrompt.get();
  if (!prompt) return;
  dismissed.add(trustKey(prompt));
  $trustPrompt.set(null);
  takeAwaitingTrust(prompt.projectPath);
}
