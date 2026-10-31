/** @typedef {import('../types/types.js').Platform} Platform */

/**
 * @param {string} userAgent
 * @returns {Platform}
 */
export function platformOf(userAgent) {
  if (/Mac/.test(userAgent)) return 'mac';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
}

/** The OS this page runs on. */
export const PLATFORM = platformOf(navigator.userAgent);
