import { generateTheme } from '@symblight/md-colors/client';

/** Seed colour the whole MD3 palette is derived from. */
const SOURCE_COLOR = '#4355b9';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Generates the palette for the current OS scheme. */
function apply() {
  const scheme = darkQuery.matches ? 'dark' : 'light';
  generateTheme({ sourceColor: SOURCE_COLOR, scheme });
  document.documentElement.dataset.theme = scheme;
}

/** Applies the MD3 palette for the current OS scheme and follows OS changes. */
export function syncThemeWithOS() {
  apply();
  darkQuery.addEventListener('change', apply);
}
