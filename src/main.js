import './styles/tokens.css';
import './styles/fonts/fonts.css';
// Before any component: every shadow root gets the shared styles.
import './styles/shadow-styles.js';
import { logUncaughtErrors } from './services/logger.js';
import { showBackendNotices } from './services/notices.js';
import { syncTheme } from './services/theme.js';
import './components/acp-app/acp-app.js';

logUncaughtErrors();
showBackendNotices();
syncTheme();

// No native context menu outside `pnpm dev` / `pnpm tauri dev` (Inspect Element stays there);
// components still get `contextmenu` to open their own menu.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
}
