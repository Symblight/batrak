// Typed `querySelector('acp-…')` / `createElement('acp-…')`. Add every new custom element here.
import type { AcpAgentColumn } from './components/acp-agent-column/acp-agent-column.js';
import type { AcpApp } from './components/acp-app/acp-app.js';
import type { AcpChangesPanel } from './components/acp-changes-panel/acp-changes-panel.js';
import type { AcpChangesReview } from './components/acp-changes-review/acp-changes-review.js';
import type { AcpChat } from './components/acp-chat/acp-chat.js';
import type { AcpCodeEditor } from './components/acp-code-editor/acp-code-editor.js';
import type { AcpMainColumn } from './components/acp-main-column/acp-main-column.js';
import type { AcpFileTree } from './components/acp-file-tree/acp-file-tree.js';
import type { AcpNavRail } from './components/acp-nav-rail/acp-nav-rail.js';
import type { AcpResizeHandle } from './components/acp-resize-handle/acp-resize-handle.js';
import type { AcpQuickOpen } from './components/acp-quick-open/acp-quick-open.js';
import type { AcpSearchPanel } from './components/acp-search-panel/acp-search-panel.js';
import type { AcpSettings } from './components/acp-settings/acp-settings.js';
import type { AcpSessionColumn } from './components/acp-session-column/acp-session-column.js';
import type { AcpToolbar } from './components/acp-toolbar/acp-toolbar.js';
import type { AcpWelcome } from './components/acp-welcome/acp-welcome.js';

declare global {
  interface HTMLElementTagNameMap {
    'acp-agent-column': AcpAgentColumn;
    'acp-app': AcpApp;
    'acp-changes-panel': AcpChangesPanel;
    'acp-changes-review': AcpChangesReview;
    'acp-chat': AcpChat;
    'acp-code-editor': AcpCodeEditor;
    'acp-main-column': AcpMainColumn;
    'acp-file-tree': AcpFileTree;
    'acp-nav-rail': AcpNavRail;
    'acp-quick-open': AcpQuickOpen;
    'acp-resize-handle': AcpResizeHandle;
    'acp-search-panel': AcpSearchPanel;
    'acp-session-column': AcpSessionColumn;
    'acp-settings': AcpSettings;
    'acp-toolbar': AcpToolbar;
    'acp-welcome': AcpWelcome;
  }
}
