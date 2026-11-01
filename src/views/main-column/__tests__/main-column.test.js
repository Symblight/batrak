import { tabs } from '../../../hooks/tabs/tabs.js';
import { app } from '../../../hooks/app/app.js';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { terminals } from '../../../hooks/terminals/terminals.js';
import { fileDrop } from '../../../hooks/file-drop/file-drop.js';
import { closeAllTabs, openAgents, openChanges, openSettings, openTab } from '../../../stores/editor/editor.js';
import { $gitChanges } from '../../../stores/git/git.js';
import { $activePath } from '../../../stores/editor/editor.js';
import { $terminals } from '../../../stores/terminals/terminals.js';
import { AcpChangesReview } from '../../../components/changes-review/changes-review.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../main-column.js';

/** @typedef {import('../main-column.js').AcpMainColumn} AcpMainColumn */
/** @typedef {import('../../../components/terminal/terminal.js').AcpTerminal} AcpTerminal */
/** @typedef {import('../../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */

/**
 * The center of `el`, in the units the webview's drag events use on this platform.
 * @param {Element} el
 */
function osPointOf(el) {
  const r = el.getBoundingClientRect();
  const scale = fileDrop.osScale(app.platformOf(navigator.userAgent), devicePixelRatio);
  return { x: (r.left + r.width / 2) * scale, y: (r.top + r.height / 2) * scale };
}

/** @type {TerminalInfo} */
const running = { cwd: '/p', fallback: '/p', label: 'zsh — p', title: null, projectPath: '/p', status: 'running', exit: null, error: null, login: null };

describe('acp-main-column', () => {
  /** @type {string[]} */
  let pasted;
  const proto = /** @type {AcpTerminal} */ (customElements.get('acp-terminal')?.prototype);
  const { paste } = proto;

  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd === 'agents_list') return { agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] };
      if (cmd === 'agents_view') return { installed: [], userAgents: [], registry: [], counts: { all: 0, updates: 0, off: 0 }, defaultAgent: null, errors: [], registryState: { checkedAt: null, offline: false, checking: false } };
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $terminals.set({ t1: running });
    openTab(tabs.terminalId('t1'));
    pasted = [];
    proto.paste = (text) => pasted.push(text);
  });

  afterEach(() => {
    proto.paste = paste;
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
    const terminal = /** @type {AcpTerminal} */ (tabView.shadowRoot?.querySelector('acp-terminal'));
    return { el, tabView, terminal };
  }

  it("types files dropped on a terminal tab as their escaped paths, and marks it while they're dragged over", async () => {
    const { el, tabView, terminal } = await render();
    const paths = ['/Users/me/Screen Shot.png', '/Users/me/a(1).txt'];
    fileDrop.handle({ type: 'enter', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    await tabView.updateComplete;
    expect(terminal.dropping, 'marked').to.equal(true);
    fileDrop.handle({ type: 'drop', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    await tabView.updateComplete;
    expect(terminal.dropping, 'unmarked').to.equal(false);
    expect(pasted).to.deep.equal([terminals.shellPaths(paths, app.platformOf(navigator.userAgent))]);
  });

  it('types nothing for files dropped outside the terminal', async () => {
    const { tabView } = await render();
    const strip = /** @type {Element} */ (tabView.shadowRoot?.querySelector('acp-tab-strip'));
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(strip) });
    expect(pasted).to.deep.equal([]);
  });

  it('types nothing into a terminal whose shell has exited', async () => {
    const { el, terminal } = await render();
    $terminals.set({ t1: { ...running, status: 'exited', exit: { code: 1, signal: null } } });
    await el.updateComplete;
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(terminal) });
    expect(pasted).to.deep.equal([]);
  });

  it('shows the Settings, Agents and Changes tabs through their views', async () => {
    // Arrange
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

  it('opens a file with a match selected, and reads the selection back', async () => {
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
  });
});
