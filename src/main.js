import { settings } from './hooks/settings/settings.js';
import './styles/tokens.css';
import './styles/fonts/fonts.css';
// Before any component: every shadow root gets the shared styles.
import './styles/shadow-styles.js';
import { app } from './hooks/app/app.js';
import { fileDrop } from './hooks/file-drop/file-drop.js';
import { perf } from './hooks/perf/perf.js';

app.init();
perf.start();
settings.syncTheme();
settings.syncEditorFont();
fileDrop.start();

// `<acp-app>` is defined, and renders, once the bundled fonts are in: the splash stays until then, and
// no text is drawn in a fallback font first.
settings.loadAppFonts().then(() => import('./views/app/app.js'));

// No native context menu outside `pnpm dev` / `pnpm tauri dev` (Inspect Element stays there);
// components still get `contextmenu` to open their own menu.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
}
