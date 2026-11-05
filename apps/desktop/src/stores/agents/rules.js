/**
 * Whether a file is the user-level agents config (`<config dir>/batrak/agents.json`): it lies outside
 * every project, yet opens in any of them.
 * @param {string} path Absolute.
 */
export function isUserAgentsFile(path) {
  return /[\\/]batrak[\\/]agents\.json$/.test(path);
}

/**
 * Whether a file is an agents config, the only kind the editor lets you edit and save for now: a
 * project's `.bt/agents.json` or the user's.
 * @param {string} path Absolute.
 */
export function isAgentsFile(path) {
  return /[\\/]\.bt[\\/]agents\.json$/.test(path) || isUserAgentsFile(path);
}
