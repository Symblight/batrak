import './styles/tokens.css';
import './styles/fonts/fonts.css';
// Before any component: every shadow root gets the shared styles.
import './styles/shadow-styles.js';
import { logUncaughtErrors } from './services/logger/logger.js';
import { showBackendNotices } from './services/notices/notices.js';
import { fileDrop } from './services/file-drop/file-drop.js';
import { syncTheme } from './services/theme/theme.js';
import './views/app/app.js';

logUncaughtErrors();
showBackendNotices();
syncTheme();
fileDrop.start();

// No native context menu outside `pnpm dev` / `pnpm tauri dev` (Inspect Element stays there);
// components still get `contextmenu` to open their own menu.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
}
