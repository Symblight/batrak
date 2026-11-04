/** @typedef {import('../../hooks/settings/types.js').Appearance} Appearance */
/** @typedef {import('../../hooks/settings/types.js').Settings} Settings */

/** Bounds of the code editor's font size, in px. */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

/** @typedef {import('../../hooks/settings/types.js').TerminalColors} TerminalColors */
/** @typedef {import('../../hooks/settings/types.js').TerminalColorKey} TerminalColorKey */
/** @typedef {import('../../hooks/settings/types.js').TerminalPalette} TerminalPalette */

/**
 * The colors a custom terminal theme starts from, every one of them.
 * @type {TerminalPalette}
 */
export const TERMINAL_PALETTE = {
  background: '#1E1E1E',
  foreground: '#CCCCCC',
  cursor: '#CCCCCC',
  black: '#000000',
  red: '#CD3131',
  green: '#0DBC79',
  yellow: '#E5E510',
  blue: '#2472C8',
  magenta: '#BC3FBC',
  cyan: '#11A8CD',
  white: '#E5E5E5',
  brightBlack: '#666666',
  brightRed: '#F14C4C',
  brightGreen: '#23D18B',
  brightYellow: '#F5F543',
  brightBlue: '#3B8EEA',
  brightMagenta: '#D670D6',
  brightCyan: '#29B8DB',
  brightWhite: '#E5E5E5',
};

/** @type {Settings} */
export const DEFAULT_SETTINGS = { appearance: 'system', accent: '#4355B9', editorFont: null, editorFontSize: 13, markdownDefaultView: 'raw', markdownScrollSync: true, terminalFont: null, terminalFontSize: null, terminalTheme: 'app', terminalColors: null };

/** @typedef {'theme' | 'editor' | 'terminal'} SettingsSection */

/** @type {Record<SettingsSection, (keyof Settings)[]>} */
export const SETTINGS_SECTIONS = { theme: ['appearance', 'accent'], editor: ['editorFont', 'editorFontSize', 'markdownDefaultView', 'markdownScrollSync'], terminal: ['terminalFont', 'terminalFontSize', 'terminalTheme', 'terminalColors'] };

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

/**
 * @param {unknown} raw
 * @returns {TerminalPalette | null} Every color there and a color; else `null`.
 */
function parsePalette(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const entries = Object.keys(TERMINAL_PALETTE).map((key) => {
    const color = /** @type {Record<string, unknown>} */ (raw)[key];
    return [key, typeof color === 'string' ? normalizeHex(color) : null];
  });
  return entries.every(([, color]) => color) ? /** @type {TerminalPalette} */ (Object.fromEntries(entries)) : null;
}

/**
 * @param {unknown} raw
 * @returns {TerminalColors | null} Both schemes' colors; else `null`.
 */
export function parseTerminalColors(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const { light, dark } = /** @type {Record<string, unknown>} */ (raw);
  const [lightColors, darkColors] = [parsePalette(light), parsePalette(dark)];
  return lightColors && darkColors ? { light: lightColors, dark: darkColors } : null;
}

/**
 * One palette for now: an edit goes to both schemes, so a pair needs no change to what's stored.
 * @param {TerminalColors} colors
 * @param {TerminalColorKey} key
 * @param {string} color
 * @returns {TerminalColors}
 */
export function withTerminalColor(colors, key, color) {
  const palette = { ...colors.dark, [key]: color };
  return { light: palette, dark: palette };
}
