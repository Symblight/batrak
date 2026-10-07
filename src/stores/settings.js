import { computed } from 'nanostores';
import { isRecord, persistentStore } from './persistent.js';

/** @typedef {import('../models/types.js').Appearance} Appearance */
/** @typedef {import('../models/types.js').Settings} Settings */

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

/** @type {Settings} */
const DEFAULTS = { appearance: 'system', accent: '#4355B9', editorFont: null, editorFontSize: 13 };

/** @type {Record<'theme' | 'editor', (keyof Settings)[]>} */
const SECTIONS = { theme: ['appearance', 'accent'], editor: ['editorFont', 'editorFontSize'] };

/** @type {Appearance[]} */
const APPEARANCES = ['light', 'dark', 'system'];

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

/** @param {unknown} size */
function isFontSize(size) {
  return Number.isInteger(size) && /** @type {number} */ (size) >= FONT_SIZE_MIN && /** @type {number} */ (size) <= FONT_SIZE_MAX;
}

/** Shared by every window. Each field falls back to its default on its own, so one bad value keeps the rest. */
export const $settings = persistentStore('brama:settings', DEFAULTS, {
  parse: (raw) => {
    if (!isRecord(raw)) return null;
    const { appearance, accent, editorFont, editorFontSize } = raw;
    return {
      appearance: APPEARANCES.find((a) => a === appearance) ?? DEFAULTS.appearance,
      accent: (typeof accent === 'string' && normalizeHex(accent)) || DEFAULTS.accent,
      editorFont: typeof editorFont === 'string' && editorFont !== '' ? editorFont : DEFAULTS.editorFont,
      editorFontSize: isFontSize(editorFontSize) ? /** @type {number} */ (editorFontSize) : DEFAULTS.editorFontSize,
    };
  },
});

export const $appearance = computed($settings, (settings) => settings.appearance);
export const $accent = computed($settings, (settings) => settings.accent);
export const $editorFont = computed($settings, (settings) => settings.editorFont);
export const $editorFontSize = computed($settings, (settings) => settings.editorFontSize);

/**
 * @template {keyof Settings} K
 * @param {K} key
 * @param {Settings[K]} value
 */
function update(key, value) {
  const settings = $settings.get();
  if (settings[key] !== value) $settings.set({ ...settings, [key]: value });
}

/** @param {Appearance} appearance */
export function setAppearance(appearance) {
  update('appearance', appearance);
}

/** @param {string} hex Ignored unless a hex colour. */
export function setAccent(hex) {
  const accent = normalizeHex(hex);
  if (accent) update('accent', accent);
}

/** @param {string | null} family `null` for the editor's default. */
export function setEditorFont(family) {
  update('editorFont', family || null);
}

/** @param {number} size Clamped to `FONT_SIZE_MIN`–`FONT_SIZE_MAX`. */
export function setEditorFontSize(size) {
  update('editorFontSize', Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size))));
}

/** @param {keyof typeof SECTIONS} section */
export function isSectionDefault(section) {
  const settings = $settings.get();
  return SECTIONS[section].every((key) => settings[key] === DEFAULTS[key]);
}

/** @param {keyof typeof SECTIONS} section */
export function resetSection(section) {
  const settings = { ...$settings.get() };
  for (const key of SECTIONS[section]) Object.assign(settings, { [key]: DEFAULTS[key] });
  $settings.set(settings);
}
