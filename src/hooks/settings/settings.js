import { generateTheme } from '@symblight/md-colors/client';
import { $systemFonts } from '../../stores/fonts/fonts.js';
import { $accent, $appearance } from '../../stores/settings/settings.js';
import { DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN, SETTINGS_SECTIONS, normalizeHex } from '../../stores/settings/rules.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').FontFamily} FontFamily */
/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('../../stores/settings/rules.js').SettingsSection} SettingsSection */

/** The editor's font when none is picked: first in `--acp-font-family-mono`, bundled in `styles/fonts/`. */
const DEFAULT_EDITOR_FONT = 'Google Sans Code';

/** @type {Promise<void> | null} */
let fontsLoading = null;

/** Generates the MD3 palette from the accent for the chosen scheme. */
function applyTheme() {
  const appearance = $appearance.get();
  const scheme = appearance === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : appearance;
  generateTheme({ sourceColor: $accent.get(), scheme });
  const root = document.documentElement;
  root.dataset.theme = scheme;
  // Native controls and scrollbars follow the chosen scheme, not the OS one.
  root.style.colorScheme = scheme;
}

/** The user's settings: what their values may be, how they look, and the theme and fonts they drive. */
export const settings = Object.freeze({
  /** @type {Settings} */
  defaults: DEFAULT_SETTINGS,
  /** Bounds of the code editor's font size, in px. */
  fontSizeMin: FONT_SIZE_MIN,
  fontSizeMax: FONT_SIZE_MAX,
  defaultEditorFont: DEFAULT_EDITOR_FONT,
  normalizeHex,

  /** @param {number} size Font size in px. */
  lineHeightFor(size) {
    return Math.round(size * 1.5);
  },

  /**
   * @param {string} family
   * @returns {string} CSS `font-family` value; the app's monospace stack takes over if `family` is gone.
   */
  fontStack(family) {
    return `"${family}", var(--acp-font-family-mono)`;
  },

  /**
   * @param {Settings} current
   * @param {SettingsSection} section
   */
  isSectionDefault(current, section) {
    return SETTINGS_SECTIONS[section].every((key) => current[key] === DEFAULT_SETTINGS[key]);
  },

  /** Applies the palette from `$settings` and regenerates it when they or the OS scheme change. */
  syncTheme() {
    $appearance.listen(applyTheme);
    $accent.listen(applyTheme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    applyTheme();
  },

  /** Lists the installed fonts into `$systemFonts`, once per window; a failure lets the next call retry. */
  loadSystemFonts() {
    fontsLoading ??= ipc
      .invoke('list_fonts')
      .then((fonts) => $systemFonts.set(/** @type {FontFamily[]} */ (fonts).sort((a, b) => a.family.localeCompare(b.family))))
      .catch((err) => {
        fontsLoading = null;
        app.reportError('Listing fonts failed', err);
      });
    return fontsLoading;
  },
});
