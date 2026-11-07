/**
 * The update's state; mirrors `app_update::AppUpdateState`.
 * @typedef {{ state: 'none' }
 *   | { state: 'available', version: string, current: string, manual: boolean }
 *   | { state: 'downloading', version: string, received: number, total: number | null }
 *   | { state: 'ready', version: string, onNextLaunch: boolean }
 *   | { state: 'installing', version: string }
 *   | { state: 'failed', version: string, reason: string }
 *   | { state: 'updated', version: string }} AppUpdateState
 */

/**
 * What a restart would stop; mirrors `app_update::RestartBlockers`.
 * @typedef {Object} RestartBlockers
 * @property {number} agents
 * @property {number} terminals
 */

/**
 * What About's row says about the check asked from it.
 * @typedef {Object} UpdateCheck
 * @property {boolean} checking
 * @property {string | null} message `null` until asked.
 */

export {};
