/** @typedef {import('./types.js').Appearance} Appearance */
/** @typedef {import('./types.js').Settings} Settings */

/** Bounds of the code editor's font size, in px. */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

/** @type {Settings} */
export const DEFAULT_SETTINGS = { appearance: 'system', accent: '#4355B9', editorFont: null, editorFontSize: 13 };

/** @typedef {'theme' | 'editor'} SettingsSection */

/** @type {Record<SettingsSection, (keyof Settings)[]>} */
export const SETTINGS_SECTIONS = { theme: ['appearance', 'accent'], editor: ['editorFont', 'editorFontSize'] };

/**
 * @param {string} value `#RGB` or `#RRGGBB`, any case, surrounding space ignored.
 * @returns {string | null} `#RRGGBB` uppercase; `null` when `value` isn't a hex colour.
 */
export function normalizeHex(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return `#${hex.toUpperCase()}`;
}

/** @param {number} size Font size in px. */
export function lineHeightFor(size) {
  return Math.round(size * 1.5);
}

/**
 * @param {Settings} settings
 * @param {SettingsSection} section
 */
export function isSectionDefault(settings, section) {
  return SETTINGS_SECTIONS[section].every((key) => settings[key] === DEFAULT_SETTINGS[key]);
}
