import { computed } from 'nanostores';
import { isRecord, persistentStore } from '../persistent/persistent.js';
import { isMarkdownMode } from '../markdown-view/markdown-view.js';
import { DEFAULT_SETTINGS as DEFAULTS, FONT_SIZE_MAX, FONT_SIZE_MIN, SETTINGS_SECTIONS as SECTIONS, normalizeHex } from './rules.js';

/** @typedef {import('../../hooks/settings/types.js').Appearance} Appearance */
/** @typedef {import('../../hooks/settings/types.js').Settings} Settings */

/** @type {Appearance[]} */
const APPEARANCES = ['light', 'dark', 'system'];

/** @param {unknown} size */
function isFontSize(size) {
  return Number.isInteger(size) && /** @type {number} */ (size) >= FONT_SIZE_MIN && /** @type {number} */ (size) <= FONT_SIZE_MAX;
}

/**
 * @param {unknown} raw
 * @returns {Settings | null}
 */
export function parseSettings(raw) {
  if (!isRecord(raw)) return null;
  const { appearance, accent, editorFont, editorFontSize, markdownDefaultView, markdownScrollSync } = raw;
  return {
    appearance: APPEARANCES.find((a) => a === appearance) ?? DEFAULTS.appearance,
    accent: (typeof accent === 'string' && normalizeHex(accent)) || DEFAULTS.accent,
    editorFont: typeof editorFont === 'string' && editorFont !== '' ? editorFont : DEFAULTS.editorFont,
    editorFontSize: isFontSize(editorFontSize) ? /** @type {number} */ (editorFontSize) : DEFAULTS.editorFontSize,
    markdownDefaultView: isMarkdownMode(markdownDefaultView) ? markdownDefaultView : DEFAULTS.markdownDefaultView,
    markdownScrollSync: typeof markdownScrollSync === 'boolean' ? markdownScrollSync : DEFAULTS.markdownScrollSync,
  };
}

/** Shared by every window. Each field falls back to its default on its own, so one bad value keeps the rest. */
export const $settings = persistentStore('brama:settings', DEFAULTS, { parse: parseSettings });

export const $appearance = computed($settings, (settings) => settings.appearance);
export const $accent = computed($settings, (settings) => settings.accent);
export const $editorFont = computed($settings, (settings) => settings.editorFont);
export const $editorFontSize = computed($settings, (settings) => settings.editorFontSize);
export const $markdownDefaultView = computed($settings, (settings) => settings.markdownDefaultView);
export const $markdownScrollSync = computed($settings, (settings) => settings.markdownScrollSync);

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

/** @param {boolean} on */
export function setMarkdownScrollSync(on) {
  update('markdownScrollSync', on);
}

/** @param {import('./rules.js').SettingsSection} section */
export function resetSection(section) {
  const settings = { ...$settings.get() };
  for (const key of SECTIONS[section]) Object.assign(settings, { [key]: DEFAULTS[key] });
  $settings.set(settings);
}
