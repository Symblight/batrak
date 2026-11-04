import { generateTheme } from '@symblight/md-colors/client';
import { $systemFonts } from '../../stores/fonts/fonts.js';
import { $accent, $appearance, $editorFont, $editorFontSize } from '../../stores/settings/settings.js';
import { DEFAULT_SETTINGS, FONT_SIZE_MAX, FONT_SIZE_MIN, SETTINGS_SECTIONS, TERMINAL_PALETTE, normalizeHex, withTerminalColor } from '../../stores/settings/rules.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';

/** @typedef {import('./types.js').FontFamily} FontFamily */
/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('../../stores/settings/rules.js').SettingsSection} SettingsSection */

/** The editor's font when none is picked: first in `--acp-font-family-mono`, bundled in `styles/fonts/`. */
const DEFAULT_EDITOR_FONT = 'Google Sans Code';

/**
 * The bundled faces (`styles/fonts/fonts.css`) the first render draws: the interface's, and the editor's
 * upright and italic (comments). Each loads only once text needs it, and `font-display: swap` would draw
 * a fallback until then.
 */
const APP_FACES = ['400 1em "Google Sans Flex"', '400 1em "Google Sans Code"', 'italic 400 1em "Google Sans Code"'];

/** How long the first render waits for them, in ms; they are read from the app bundle, not the network. */
const APP_FONTS_WAIT = 1000;

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

/** @param {number} size Font size in px. */
function lineHeightFor(size) {
  return Math.round(size * 1.5);
}

/**
 * @param {string} family
 * @returns {string} CSS `font-family` value; the app's monospace stack takes over if `family` is gone.
 */
function fontStack(family) {
  return `"${family}", var(--acp-font-family-mono)`;
}

/** Puts the editor font on `<html>`, where every `cdx-code-editor` inherits it; no font picked keeps `tokens.css`'s. */
function applyEditorFont() {
  const family = $editorFont.get();
  const size = $editorFontSize.get();
  const style = document.documentElement.style;
  if (family) style.setProperty('--cdx-code-editor-mono-font-family', fontStack(family));
  else style.removeProperty('--cdx-code-editor-mono-font-family');
  style.setProperty('--cdx-code-editor-code-font-size', `${size}px`);
  style.setProperty('--cdx-code-editor-code-line-height', `${lineHeightFor(size)}px`);
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
  terminalPalette: TERMINAL_PALETTE,
  withTerminalColor,

  lineHeightFor,
  fontStack,

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

  /** Applies the code editors' font from `$settings` to the page, and again when it changes. */
  syncEditorFont() {
    $editorFont.listen(applyEditorFont);
    $editorFontSize.listen(applyEditorFont);
    applyEditorFont();
  },

  /**
   * Loads the bundled faces, so the first render isn't drawn in a fallback font that is swapped
   * moments later. Never rejects: a face that fails, or takes longer than `wait`, is left to `swap`.
   * @param {number} [wait] ms
   * @returns {Promise<void>}
   */
  loadAppFonts(wait = APP_FONTS_WAIT) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const loads = Promise.allSettled(APP_FACES.map((face) => document.fonts.load(face)));
    const timeout = new Promise((resolve) => (timer = setTimeout(resolve, wait)));
    return Promise.race([loads, timeout]).then(() => clearTimeout(timer));
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
