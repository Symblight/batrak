import { tabs } from '../../../hooks/tabs/tabs.js';
import { app } from '../../../hooks/app/app.js';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { terminals } from '../../../hooks/terminals/terminals.js';
import { fileDrop } from '../../../hooks/file-drop/file-drop.js';
import { closeAllTabs, openTab } from '../../../stores/editor/editor.js';
import { $terminals } from '../../../stores/terminals/terminals.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../main-column.js';

/** @typedef {import('../main-column.js').AcpMainColumn} AcpMainColumn */
/** @typedef {import('../../../components/terminal/terminal.js').AcpTerminal} AcpTerminal */
/** @typedef {import('../../../models/types/types.js').TerminalInfo} TerminalInfo */

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
    mockIPC(() => null);
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
