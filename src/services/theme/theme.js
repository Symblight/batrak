import { generateTheme } from '@symblight/md-colors/client';
import { $accent, $appearance } from '../../stores/settings/settings.js';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Generates the MD3 palette from the accent for the chosen scheme. */
function apply() {
  const appearance = $appearance.get();
  const scheme = appearance === 'system' ? (darkQuery.matches ? 'dark' : 'light') : appearance;
  generateTheme({ sourceColor: $accent.get(), scheme });
  const root = document.documentElement;
  root.dataset.theme = scheme;
  // Native controls and scrollbars follow the chosen scheme, not the OS one.
  root.style.colorScheme = scheme;
}

/** Applies the palette from `$settings` and regenerates it when they or the OS scheme change. */
export function syncTheme() {
  $appearance.listen(apply);
  $accent.listen(apply);
  darkQuery.addEventListener('change', apply);
  apply();
}
