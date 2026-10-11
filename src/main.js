import './styles/tokens.css';
import { logUncaughtErrors } from './services/logger.js';
import { syncTheme } from './services/theme.js';
import './components/acp-app/acp-app.js';

logUncaughtErrors();
syncTheme();
