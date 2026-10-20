/** @typedef {import('./types.js').ConfirmOptions} ConfirmOptions */
/** @typedef {import('./types.js').TrustPrompt} TrustPrompt */

/**
 * What the trust dialog asks when a project's agents.json chooses what its agents run.
 * @param {TrustPrompt} prompt
 * @returns {ConfirmOptions}
 */
export function trustConfirm(prompt) {
  const project = prompt.projectPath.split(/[\\/]/).pop() || prompt.projectPath;
  return {
    headline: 'Trust this project?',
    message: `Brama provides features that may run potentially malicious code from "${project}".`,
    detail: "If you don't trust the source, choose Not now to only browse its code: its agents won't start.",
    confirmLabel: 'Trust project',
    cancelLabel: 'Not now',
    placement: 'top',
  };
}

/**
 * Tells prompts apart by project and what they ask to trust, so "Not now" holds until that changes.
 * @param {TrustPrompt} prompt
 */
export function trustKey(prompt) {
  return JSON.stringify([prompt.projectPath, prompt.agents.map((a) => a.launch)]);
}
