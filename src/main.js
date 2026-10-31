import './styles/tokens.css';
import './styles/fonts/fonts.css';
// Before any component: every shadow root gets the shared styles.
import './styles/shadow-styles.js';
import { app } from './hooks/app/app.js';
import { fileDrop } from './services/file-drop/file-drop.js';
import { syncTheme } from './services/theme/theme.js';
import './views/app/app.js';

app.init();
syncTheme();
fileDrop.start();

// No native context menu outside `pnpm dev` / `pnpm tauri dev` (Inspect Element stays there);
// components still get `contextmenu` to open their own menu.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
}
