// Typed `querySelector('acp-…')` / `createElement('acp-…')`. Add every new custom element here.
import type { AcpAboutDialog } from './components/acp-about-dialog/acp-about-dialog.js';
import type { AcpAgentColumn } from './components/acp-agent-column/acp-agent-column.js';
import type { AcpApp } from './components/acp-app/acp-app.js';
import type { AcpChangesPanel } from './components/acp-changes-panel/acp-changes-panel.js';
import type { AcpChangesReview } from './components/acp-changes-review/acp-changes-review.js';
import type { AcpChat } from './components/acp-chat/acp-chat.js';
import type { AcpTabView } from './components/acp-tab-view/acp-tab-view.js';
import type { AcpMainColumn } from './components/acp-main-column/acp-main-column.js';
import type { AcpFileColumn } from './components/acp-file-column/acp-file-column.js';
import type { AcpFileTree } from './components/acp-file-tree/acp-file-tree.js';
import type { AcpNavRail } from './components/acp-nav-rail/acp-nav-rail.js';
import type { AcpResizeHandle } from './components/acp-resize-handle/acp-resize-handle.js';
import type { AcpQuickOpen } from './components/acp-quick-open/acp-quick-open.js';
import type { AcpSearchPanel } from './components/acp-search-panel/acp-search-panel.js';
import type { AcpSettings } from './components/acp-settings/acp-settings.js';
import type { AcpSnackbars } from './components/acp-snackbars/acp-snackbars.js';
import type { AcpSessionColumn } from './components/acp-session-column/acp-session-column.js';
import type { AcpToolbar } from './components/acp-toolbar/acp-toolbar.js';
import type { AcpWelcome } from './components/acp-welcome/acp-welcome.js';

declare global {
  interface HTMLElementTagNameMap {
    'acp-about-dialog': AcpAboutDialog;
    'acp-agent-column': AcpAgentColumn;
    'acp-app': AcpApp;
    'acp-changes-panel': AcpChangesPanel;
    'acp-changes-review': AcpChangesReview;
    'acp-chat': AcpChat;
    'acp-tab-view': AcpTabView;
    'acp-main-column': AcpMainColumn;
    'acp-file-column': AcpFileColumn;
    'acp-file-tree': AcpFileTree;
    'acp-nav-rail': AcpNavRail;
    'acp-quick-open': AcpQuickOpen;
    'acp-resize-handle': AcpResizeHandle;
    'acp-search-panel': AcpSearchPanel;
    'acp-session-column': AcpSessionColumn;
    'acp-settings': AcpSettings;
    'acp-snackbars': AcpSnackbars;
    'acp-toolbar': AcpToolbar;
    'acp-welcome': AcpWelcome;
  }
}
