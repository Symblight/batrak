import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import { fileDrop } from '../../../hooks/file-drop/file-drop.js';
import { terminals } from '../../../hooks/terminals/terminals.js';
import { $settings } from '../../../stores/settings/settings.js';
import { $terminals } from '../../../stores/terminals/terminals.js';
import { AcpTerminal } from '../../../components/terminal/terminal.js';
import '../terminal-view.js';

/** @typedef {import('../terminal-view.js').AcpTerminalView} AcpTerminalView */
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

describe('acp-terminal-view', () => {
  /** @type {string[]} */
  let pasted;
  const clipboardWrite = navigator.clipboard.writeText;
  const proto = /** @type {AcpTerminal} */ (customElements.get('acp-terminal')?.prototype);
  const { paste } = proto;

  beforeEach(() => {
    mockIPC(() => null);
    $terminals.set({ t1: running });
    pasted = [];
    proto.paste = (text) => pasted.push(text);
  });

  afterEach(() => {
    proto.paste = paste;
    navigator.clipboard.writeText = clipboardWrite;
    fileDrop.handle({ type: 'leave' });
    $terminals.set({});
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpTerminalView, terminal: AcpTerminal }>} */
  async function render() {
    const el = /** @type {AcpTerminalView} */ (await fixture(html`<acp-terminal-view terminal-id="t1"></acp-terminal-view>`));
    return { el, terminal: /** @type {AcpTerminal} */ (el.querySelector('acp-terminal')) };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} detail
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('shows the terminal its id names, in the editor’s font, and nothing once the terminal is gone', async () => {
    // Arrange
    $settings.set({ ...$settings.get(), editorFont: 'Mono X', editorFontSize: 15 });
    const { el, terminal } = await render();
    // Assert
    expect([terminal.terminalId, terminal.info, terminal.connect === terminals.connect]).to.deep.equal(['t1', running, true]);
    expect([terminal.fontFamily, terminal.fontSize]).to.deep.equal(['Mono X', 15]);
    // Act
    $terminals.set({});
    await el.updateComplete;
    // Assert
    expect(el.querySelector('acp-terminal')).to.equal(null);
  });

  it('copies, restarts and titles on the terminal’s asks, and none leaves the view', async () => {
    // Arrange
    $terminals.set({ t1: { ...running, status: 'exited', exit: { code: 0, signal: null } } });
    const { el, terminal } = await render();
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-terminal-copy', 'acp-terminal-restart', 'acp-terminal-title']) el.addEventListener(type, (e) => leaked.push(e));
    /** @type {unknown[]} */
    const links = [];
    el.addEventListener('acp-link-open', (e) => links.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {string[]} */
    const copied = [];
    navigator.clipboard.writeText = async (text) => void copied.push(text);
    // Act
    fire(terminal, 'acp-terminal-copy', { text: 'ls -la' });
    fire(terminal, 'acp-terminal-restart', { terminalId: 't1' });
    fire(terminal, 'acp-terminal-title', { terminalId: 't1', title: 'vim' });
    await Promise.resolve();
    // Assert
    expect(copied).to.deep.equal(['ls -la']);
    expect($terminals.get().t1.title).to.equal('vim');
    expect($terminals.get().t1.status, 'starting again').to.equal('starting');
    // Act: a link is for the column
    fire(terminal, 'acp-link-open', { url: 'https://example.com' });
    // Assert
    expect(links, 'links still reach the column').to.deep.equal([{ url: 'https://example.com' }]);
    expect(leaked).to.deep.equal([]);
  });

  it("types files dropped on the terminal as their escaped paths, and marks it while they're dragged over", async () => {
    const { el, terminal } = await render();
    const paths = ['/Users/me/Screen Shot.png', '/Users/me/a(1).txt'];
    fileDrop.handle({ type: 'enter', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    expect(terminal.dropping, 'marked').to.equal(true);
    fileDrop.handle({ type: 'drop', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    expect(terminal.dropping, 'unmarked').to.equal(false);
    expect(pasted).to.deep.equal([terminals.shellPaths(paths, app.platformOf(navigator.userAgent))]);
  });

  it('types nothing for files dropped on a terminal whose shell has exited', async () => {
    const { el, terminal } = await render();
    $terminals.set({ t1: { ...running, status: 'exited', exit: { code: 1, signal: null } } });
    await el.updateComplete;
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(terminal) });
    expect(pasted).to.deep.equal([]);
  });

  it('marks and types into only the terminal the files are over, not another view’s', async () => {
    // Arrange: the first terminal fills the top of the page, the second view sits below it
    const { terminal: first } = await render();
    $terminals.set({ t1: running, t2: running });
    const other = /** @type {AcpTerminalView} */ (await fixture(html`<acp-terminal-view terminal-id="t2"></acp-terminal-view>`));
    const second = /** @type {AcpTerminal} */ (other.querySelector('acp-terminal'));
    await second.updateComplete;
    const scale = fileDrop.osScale(app.platformOf(navigator.userAgent), devicePixelRatio);
    const box = second.getBoundingClientRect();
    // The second terminal starts below the first, so a point near its top is inside the viewport.
    const position = { x: (box.left + 40) * scale, y: (box.top + 20) * scale };
    // Act
    fileDrop.handle({ type: 'enter', paths: ['/a.png'], position });
    await second.updateComplete;
    await first.updateComplete;
    // Assert
    expect([second.dropping, first.dropping], 'only the one under the files').to.deep.equal([true, false]);
    // Act
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position });
    // Assert: typed once (by the second view), not twice
    expect(pasted).to.have.length(1);
  });
});
