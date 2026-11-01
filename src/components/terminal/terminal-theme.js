/** @typedef {import('@xterm/xterm').ITheme} ITheme */

/** The 16 ANSI colors on a light background. */
const ANSI_LIGHT = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

/** The 16 ANSI colors on a dark background. */
const ANSI_DARK = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

/**
 * @param {string} color `#rrggbb` or `rgb(r, g, b)`; anything else is returned as is.
 * @param {number} alpha 0–1.
 */
function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return `rgba(${hex.slice(1).map((h) => parseInt(h, 16)).join(', ')}, ${alpha})`;
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  return rgb ? `rgba(${rgb.slice(1).join(', ')}, ${alpha})` : color;
}

/**
 * xterm's colors: the app's surface, text and primary (from its tokens), and a fixed ANSI set.
 * @param {{ background: string, foreground: string, primary: string }} tokens Resolved colors; an
 *   empty one keeps xterm's default.
 * @param {boolean} dark
 * @returns {ITheme}
 */
export function terminalTheme({ background, foreground, primary }, dark) {
  return {
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
    ...(background && { background }),
    ...(foreground && { foreground }),
    ...(primary && {
      cursor: primary,
      cursorAccent: background || undefined,
      selectionBackground: withAlpha(primary, 0.3),
    }),
  };
}
