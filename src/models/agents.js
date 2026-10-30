/** @typedef {'claude' | 'codex' | 'copilot' | 'antigravity'} AgentBrand */

/** @type {readonly [RegExp, AgentBrand][]} */
const BRANDS = [
  [/claude/, 'claude'],
  [/codex/, 'codex'],
  [/copilot/, 'copilot'],
  [/antigravity/, 'antigravity'],
];

/**
 * Which of the supported agents this one is, by its id or name (ids differ between agents.json
 * files); `null`: none of them.
 * @param {string} agentId
 * @param {string | null | undefined} name
 * @returns {AgentBrand | null}
 */
export function agentBrandOf(agentId, name) {
  const text = `${agentId} ${name ?? ''}`.toLowerCase();
  return BRANDS.find(([re]) => re.test(text))?.[1] ?? null;
}

/**
 * Splits typed arguments as a shell would: on whitespace, with `'…'`, `"…"` and `\` keeping
 * spaces in one argument. Nothing is expanded.
 * @param {string} text
 * @returns {string[]}
 */
export function splitArgs(text) {
  /** @type {string[]} */
  const args = [];
  /** @type {string | null} The argument being read; `null` between arguments. */
  let arg = null;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else arg += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      arg ??= '';
    } else if (c === '\\' && i + 1 < text.length) {
      arg = (arg ?? '') + text[++i];
    } else if (/\s/.test(c)) {
      if (arg !== null) args.push(arg);
      arg = null;
    } else {
      arg = (arg ?? '') + c;
    }
  }
  if (arg !== null) args.push(arg);
  return args;
}

/** @param {string} arg */
function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * A program and its arguments as one line, quoted so `parseCommandLine()` gives them back.
 * @param {string} command
 * @param {readonly string[]} args
 */
export function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * A typed command line as a program and its arguments (`command` is `''` when nothing was typed).
 * @param {string} line
 */
export function parseCommandLine(line) {
  const [command = '', ...args] = splitArgs(line);
  return { command, args };
}

/**
 * The ways to sign in from the app: the agent's own (`authenticate`) and logins run in a terminal.
 * An API key is set in the agent's environment instead.
 * @param {readonly import('./types.js').SignInMethod[]} methods
 */
export function ownSignIns(methods) {
  return methods.filter((m) => m.apiKey === null);
}

/**
 * How to sign in to an agent just added, from its probe: `null` when it needs no sign-in; else its
 * only method, or `methodId: null` when its row has to offer the choice (or only Retry).
 * @param {import('./types.js').ProbedOptions} probed
 * @returns {{ methodId: string | null } | null}
 */
export function signInAfterAdd(probed) {
  if (Array.isArray(probed)) return null;
  const methods = ownSignIns(probed.signIn);
  return { methodId: methods.length === 1 ? methods[0].id : null };
}
