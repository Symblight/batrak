import { tabs } from '../../../hooks/tabs/tabs.js';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $activePath, closeAllTabs, openAgents, openChanges, openSettings, openTab } from '../../../stores/editor/editor.js';
import { $gitChanges } from '../../../stores/git/git.js';
import { $terminals } from '../../../stores/terminals/terminals.js';
import { AcpChangesReview } from '../../../components/changes-review/changes-review.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../main-column.js';

/** @typedef {import('../main-column.js').AcpMainColumn} AcpMainColumn */
/** @typedef {import('../../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */

/** @type {TerminalInfo} */
const running = { cwd: '/p', fallback: '/p', label: 'zsh — p', title: null, projectPath: '/p', status: 'running', exit: null, error: null, login: null };

describe('acp-main-column', () => {
  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd === 'agents_list') return { agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] };
      if (cmd === 'agents_view') return { installed: [], userAgents: [], registry: [], counts: { all: 0, updates: 0, off: 0 }, defaultAgent: null, errors: [], registryState: { checkedAt: null, offline: false, checking: false } };
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $terminals.set({ t1: running });
  });

  afterEach(() => {
    closeAllTabs();
    $terminals.set({});
    $gitChanges.set({ files: [], loaded: false, loading: false, error: null });
    $workspace.set(null);
    clearMocks();
  });

  async function render() {
    const el = /** @type {AcpMainColumn} */ (await fixture(html`<acp-main-column style="display: flex; width: 800px; height: 500px"></acp-main-column>`));
    const tabView = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (el.querySelector('acp-tab-view'));
    await tabView.updateComplete;
    return { el, tabView };
  }

  it('shows the Settings, Agents, Changes and terminal tabs through their views', async () => {
    // Arrange
    openTab(tabs.terminalId('t1'));
    openTab(tabs.sessionChangesId('s1'));
    openChanges();
    openAgents();
    openSettings();
    // Act
    const { tabView } = await render();
    const view = /** @type {HTMLElementTagNameMap['acp-settings-view']} */ (tabView.shadowRoot?.querySelector('acp-settings-view'));
    await view.updateComplete;
    const settings = /** @type {HTMLElementTagNameMap['acp-settings']} */ (view.querySelector('acp-settings'));
    await settings.updateComplete;
    // Assert
    const panel = /** @type {HTMLElement} */ (settings.closest('.acp-tab-view__panel'));
    expect(panel.hasAttribute('active')).to.equal(true);
    expect(tabView.shadowRoot?.querySelector('acp-agents-tab acp-agents-view'), 'the Agents tab too').to.not.equal(null);
    expect(tabView.shadowRoot?.querySelector('acp-changes-tab acp-changes-review'), 'and the Changes tab').to.not.equal(null);
    expect(tabView.shadowRoot?.querySelector('acp-session-changes-tab')?.sessionId, 'and a session’s Changes tab').to.equal('s1');
    expect(tabView.shadowRoot?.querySelector('acp-terminal-view')?.getAttribute('terminal-id'), 'and a terminal').to.equal('t1');
  });

  it('opens the Changes tab with a changed file’s diff expanded and scrolled into view', async () => {
    // Arrange
    $gitChanges.set({ files: [{ path: 'a.js', kind: 'modified', staged: false, unstaged: true, origPath: null, added: 1, removed: 0 }], loaded: true, loading: false, error: null });
    const { el, tabView } = await render();
    /** @type {string[]} */
    const scrolled = [];
    const original = AcpChangesReview.prototype.scrollToChange;
    AcpChangesReview.prototype.scrollToChange = async function scrollToChange(id) {
      scrolled.push(id);
    };
    try {
      // Act
      await el.showChange('/p/a.js');
    } finally {
      AcpChangesReview.prototype.scrollToChange = original;
    }
    // Assert
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (tabView.shadowRoot?.querySelector('acp-changes-tab acp-changes-review'));
    expect($activePath.get()).to.equal('view:changes');
    expect([...review.expanded]).to.deep.equal(['a.js']);
    expect(scrolled).to.deep.equal(['a.js']);
  });

  it('shows a file in its editor view, with a match selected, and reads the selection back', async () => {
    mockIPC((cmd) => (cmd === 'read_file' ? 'first\nsecond needle\n' : null));
    // Files are read only once the project's root is open.
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    const { el } = await render();
    el.openFile('/p/a.txt', { line: 2, column: 8, length: 6 });
    const started = Date.now();
    while (el.selectedText() !== 'needle') {
      expect(Date.now() - started, 'timed out').to.be.lessThan(1500);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(el.querySelector('acp-tab-view')?.shadowRoot?.querySelector('acp-editor-view acp-code-view'), 'through the editor view').to.not.equal(null);
  });
});
