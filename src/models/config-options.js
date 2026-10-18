/** @typedef {import('./types.js').ConfigOption} ConfigOption */

/**
 * The first option of a category, in the agent's order.
 * @param {readonly ConfigOption[]} options
 * @param {string} category
 */
export function configOf(options, category) {
  return options.find((o) => o.category === category) ?? null;
}

/**
 * @param {ConfigOption | null} option
 * @returns {string | null} The current value's name.
 */
export function currentName(option) {
  return option?.options.find((v) => v.value === option.currentValue)?.name ?? null;
}
