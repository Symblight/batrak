import { settings } from './hooks/settings/settings.js';
import './styles/tokens.css';
import './styles/fonts/fonts.css';
// Before any component: every shadow root gets the shared styles.
import './styles/shadow-styles.js';
import { app } from './hooks/app/app.js';
import { fileDrop } from './services/file-drop/file-drop.js';
import './views/app/app.js';

app.init();
settings.syncTheme();
fileDrop.start();

// No native context menu outside `pnpm dev` / `pnpm tauri dev` (Inspect Element stays there);
// components still get `contextmenu` to open their own menu.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
}
