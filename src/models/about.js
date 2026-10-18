/** @typedef {import('./types.js').AboutInfo} AboutInfo */

/**
 * Label and value of each About row, in display order.
 * @param {AboutInfo} about
 * @returns {[string, string][]}
 */
export function aboutRows(about) {
  return [
    ['Version', about.version],
    ['OS', `${about.os} ${about.arch}`],
    ['Logs', about.logDir ?? 'unknown'],
  ];
}
