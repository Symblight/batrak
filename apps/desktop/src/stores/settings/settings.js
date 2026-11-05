import { computed } from 'nanostores';
import { isRecord, persistentMapStore, persistentStore } from '../persistent/persistent.js';
import { $projectPath } from '../project/project.js';
import { isMarkdownMode } from '../markdown-view/markdown-view.js';
import { DEFAULT_SETTINGS as DEFAULTS, FONT_SIZE_MAX, FONT_SIZE_MIN, SETTINGS_SECTIONS as SECTIONS, TERMINAL_PALETTE, normalizeHex, parseTerminalColors } from './rules.js';

/** @typedef {import('../../hooks/settings/types.js').Appearance} Appearance */
/** @typedef {import('../../hooks/settings/types.js').ProjectAccent} ProjectAccent */
/** @typedef {import('../../hooks/settings/types.js').Settings} Settings */

/** @type {Appearance[]} */
const APPEARANCES = ['light', 'dark', 'system'];

/**
 * @param {unknown} raw
 * @returns {ProjectAccent | null}
 */
function parseProjectAccent(raw) {
  if (!isRecord(raw) || typeof raw.color !== 'string' || typeof raw.enabled !== 'boolean') return null;
  const color = normalizeHex(raw.color);
  return color ? { color, enabled: raw.enabled } : null;
}

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
  const { appearance, accent, editorFont, editorFontSize, markdownDefaultView, markdownScrollSync, terminalFont, terminalFontSize, terminalTheme, terminalColors, terminalOptionMeta } = raw;
  const colors = parseTerminalColors(terminalColors);
  return {
    appearance: APPEARANCES.find((a) => a === appearance) ?? DEFAULTS.appearance,
    accent: (typeof accent === 'string' && normalizeHex(accent)) || DEFAULTS.accent,
    editorFont: typeof editorFont === 'string' && editorFont !== '' ? editorFont : DEFAULTS.editorFont,
    editorFontSize: isFontSize(editorFontSize) ? /** @type {number} */ (editorFontSize) : DEFAULTS.editorFontSize,
    markdownDefaultView: isMarkdownMode(markdownDefaultView) ? markdownDefaultView : DEFAULTS.markdownDefaultView,
    markdownScrollSync: typeof markdownScrollSync === 'boolean' ? markdownScrollSync : DEFAULTS.markdownScrollSync,
    terminalFont: typeof terminalFont === 'string' && terminalFont !== '' ? terminalFont : DEFAULTS.terminalFont,
    terminalFontSize: isFontSize(terminalFontSize) ? /** @type {number} */ (terminalFontSize) : DEFAULTS.terminalFontSize,
    terminalTheme: terminalTheme === 'custom' && colors ? 'custom' : DEFAULTS.terminalTheme,
    terminalColors: colors,
    terminalOptionMeta: typeof terminalOptionMeta === 'boolean' ? terminalOptionMeta : DEFAULTS.terminalOptionMeta,
  };
}

/** Shared by every window. Each field falls back to its default on its own, so one bad value keeps the rest. */
export const $settings = persistentStore('brama:settings', DEFAULTS, { parse: parseSettings });

export const $appearance = computed($settings, (settings) => settings.appearance);
export const $accent = computed($settings, (settings) => settings.accent);
/** A project's own accent by its path, shared by every window. */
const $projectAccents = persistentMapStore('brama:settings:project-accent:', parseProjectAccent, { listen: true });
/** The shown project's own accent, on or off; `null` when it never had one, or no project is shown. */
export const $projectAccent = computed([$projectPath, $projectAccents], (path, accents) => (path && accents[path]) || null);
/** The accent this window is painted with. */
export const $themeAccent = computed([$projectAccent, $accent], (own, accent) => (own?.enabled ? own.color : accent));
export const $editorFont = computed($settings, (settings) => settings.editorFont);
export const $editorFontSize = computed($settings, (settings) => settings.editorFontSize);
export const $markdownDefaultView = computed($settings, (settings) => settings.markdownDefaultView);
export const $markdownScrollSync = computed($settings, (settings) => settings.markdownScrollSync);
/** The terminal's custom colors; `null` while it has the app's. */
export const $terminalColors = computed($settings, (settings) => (settings.terminalTheme === 'custom' ? settings.terminalColors : null));
export const $terminalOptionMeta = computed($settings, (settings) => settings.terminalOptionMeta);
/** The terminal's own font, else the editor's. */
export const $terminalFontFamily = computed($settings, (settings) => settings.terminalFont ?? settings.editorFont);
export const $terminalFontSize = computed($settings, (settings) => settings.terminalFontSize ?? settings.editorFontSize);

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

/** @param {ProjectAccent | undefined} own For the shown project; `undefined` forgets it. */
function writeProjectAccent(own) {
  const path = $projectPath.get();
  if (path) $projectAccents.setKey(path, own);
}

/** @param {string} hex The shown project's color, which switches it on; ignored unless a hex colour. */
export function setProjectAccent(hex) {
  const color = normalizeHex(hex);
  if (color) writeProjectAccent({ color, enabled: true });
}

/** @param {boolean} enabled For the shown project; its first color is the global accent's. */
export function setProjectAccentEnabled(enabled) {
  writeProjectAccent({ color: $projectAccent.get()?.color ?? $accent.get(), enabled });
}

/** Forgets the shown project's color too. */
export function clearProjectAccent() {
  writeProjectAccent(undefined);
}

/** @param {string | null} family `null` for the editor's default. */
export function setEditorFont(family) {
  update('editorFont', family || null);
}

/** @param {number} size Clamped to `FONT_SIZE_MIN`–`FONT_SIZE_MAX`. */
export function setEditorFontSize(size) {
  update('editorFontSize', Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size))));
}

/** @param {string | null} family `null` follows the editor's. */
export function setTerminalFont(family) {
  update('terminalFont', family || null);
}

/** @param {number | null} size Clamped to `FONT_SIZE_MIN`–`FONT_SIZE_MAX`; `null` follows the editor's. */
export function setTerminalFontSize(size) {
  update('terminalFontSize', size === null ? null : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size))));
}

/** @param {Settings['terminalTheme']} theme Custom starts from the colors kept, or the default ones. */
export function setTerminalTheme(theme) {
  const settings = $settings.get();
  const terminalColors = theme === 'custom' ? settings.terminalColors ?? { light: TERMINAL_PALETTE, dark: TERMINAL_PALETTE } : settings.terminalColors;
  $settings.set({ ...settings, terminalTheme: theme, terminalColors });
}

/** @param {import('../../hooks/settings/types.js').TerminalColors} colors Ignored unless all are colors. */
export function setTerminalColors(colors) {
  const parsed = parseTerminalColors(colors);
  if (parsed) update('terminalColors', parsed);
}

/** @param {boolean} on */
export function setTerminalOptionMeta(on) {
  update('terminalOptionMeta', on);
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
  if (section === 'theme') clearProjectAccent();
}
