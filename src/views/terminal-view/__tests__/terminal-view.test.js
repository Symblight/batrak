import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import { fileDrop } from '../../../hooks/file-drop/file-drop.js';
import { terminals } from '../../../hooks/terminals/terminals.js';
import { $settings } from '../../../stores/settings/settings.js';
import { DEFAULT_SETTINGS, TERMINAL_PALETTE } from '../../../stores/settings/rules.js';
import { $pendingInput, addDrop } from '../../../stores/chat/chat.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { $terminalFocus, $terminals, $windowsBuild, addSessionTerminal, focusTerminal } from '../../../stores/terminals/terminals.js';
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
const running = { cwd: '/p', fallback: '/p', label: 'zsh — p', title: null, folder: '/p', projectPath: '/p', status: 'running', exit: null, error: null, login: null };

describe('acp-terminal-view', () => {
  /** @type {string[]} */
  let pasted;
  const clipboardWrite = navigator.clipboard.writeText;
  const proto = /** @type {AcpTerminal} */ (customElements.get('acp-terminal')?.prototype);
  const { paste } = proto;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      return null;
    });
    $terminals.set({ t1: running });
    pasted = [];
    proto.paste = (text) => pasted.push(text);
  });

  afterEach(() => {
    proto.paste = paste;
    navigator.clipboard.writeText = clipboardWrite;
    fileDrop.handle({ type: 'leave' });
    $terminals.set({});
    $terminalFocus.set(null);
    $pendingInput.set({});
    $sessions.set([]);
    clearMocks();
  });

  /** @type {string[]} */
  let calls = [];

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

  it('answers a request to focus its terminal, and leaves another terminal\'s', async () => {
    // Arrange
    const { el, terminal } = await render();
    let focused = 0;
    terminal.focus = () => focused++;
    // Act
    focusTerminal('other');
    await el.updateComplete;
    // Assert
    expect(focused, 'not its terminal').to.equal(0);
    expect($terminalFocus.get(), 'waits for its view').to.deep.equal({ terminalId: 'other' });
    // Act
    focusTerminal('t1');
    await el.updateComplete;
    // Assert
    expect(focused).to.equal(1);
    expect($terminalFocus.get(), 'answered').to.equal(null);
  });

  it('shows the terminal its id names, in the editor’s font, and nothing once the terminal is gone', async () => {
    // Arrange
    $settings.set({ ...$settings.get(), editorFont: 'Mono X', editorFontSize: 15 });
    const { el, terminal } = await render();
    // Assert
    expect([terminal.terminalId, terminal.info, terminal.connect === terminals.connect]).to.deep.equal(['t1', running, true]);
    expect([terminal.fontFamily, terminal.fontSize]).to.deep.equal(['Mono X', 15]);
    expect(terminal.colors, 'the app’s').to.equal(null);
    expect(terminal.windowsBuild, 'not on Windows').to.equal(null);
    // Act
    $windowsBuild.set(19045);
    await el.updateComplete;
    // Assert
    expect(terminal.windowsBuild).to.equal(19045);
    $windowsBuild.set(null);
    // Act
    $settings.set({ ...$settings.get(), terminalTheme: 'custom', terminalColors: { light: TERMINAL_PALETTE, dark: TERMINAL_PALETTE } });
    await el.updateComplete;
    // Assert
    expect(terminal.colors?.dark).to.equal(TERMINAL_PALETTE);
    $settings.set(DEFAULT_SETTINGS);
    // Act
    $terminals.set({});
    await el.updateComplete;
    // Assert
    expect(el.querySelector('acp-terminal')).to.equal(null);
  });

  it('asks before pasting lines that would each run, and pastes them only on yes', async () => {
    for (const [answer, sent] of /** @type {[boolean, string[]][]} */ ([[true, ['ls\nrm x']], [false, []]])) {
      // Arrange
      const { el, terminal } = await render();
      /** @type {string[]} */
      const lines = [];
      terminal.pasteLines = (text) => lines.push(text);
      /** @type {import('../../../hooks/app/types.js').ConfirmOptions[]} */
      const asked = [];
      const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (el.querySelector('acp-confirm-dialog'));
      dialog.confirm = async (options) => (asked.push(options), answer);
      // Act
      fire(terminal, 'acp-terminal-paste-lines', { text: 'ls\nrm x' });
      await Promise.resolve();
      await Promise.resolve();
      // Assert
      expect(asked[0].headline).to.include('2 lines');
      expect(lines, `answered ${answer}`).to.deep.equal(sent);
    }
  });

  it('copies, opens links, restarts and titles on the terminal’s asks, and none leaves the view', async () => {
    // Arrange
    $terminals.set({ t1: { ...running, status: 'exited', exit: { code: 0, signal: null } } });
    const { el, terminal } = await render();
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-terminal-copy', 'acp-terminal-restart', 'acp-terminal-title']) el.addEventListener(type, (e) => leaked.push(e));
    /** @type {unknown[]} */
    const links = [];
    el.addEventListener('acp-link-open', (e) => links.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {unknown[]} */
    const opened = [];
    mockIPC((cmd, args) => {
      if (cmd === 'open_url') opened.push(args);
      return null;
    });
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
    // Act
    fire(terminal, 'acp-link-open', { url: 'https://example.com' });
    // Assert
    expect(opened, 'wherever the terminal is shown').to.deep.equal([{ url: 'https://example.com' }]);
    expect(links, 'handled here').to.deep.equal([]);
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

  it("shows a session's CLI: its own controls go to the session, and files dropped on it are left to the session's input", async () => {
    // Arrange: an exited CLI with one input waiting
    addSessionTerminal('t1', 's1', '/p', 'Claude Code');
    $terminals.set({ t1: { ...$terminals.get().t1, status: 'exited', exit: { code: 0, signal: null } } });
    $sessions.set([/** @type {import('../../../hooks/sessions/types.js').Session} */ ({ id: 's1', agentName: 'Claude Code', folder: '/p', status: 'stopped' })]);
    addDrop(['/a.png'], 's1');
    const el = /** @type {AcpTerminalView} */ (await fixture(html`<acp-terminal-view terminal-id="t1" session-id="s1"></acp-terminal-view>`));
    const terminal = /** @type {AcpTerminal} */ (el.querySelector('acp-terminal'));
    /** @type {unknown[]} */
    const views = [];
    el.addEventListener('acp-session-view', (e) => views.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {string[]} */
    const titled = [];
    const unsubscribe = $terminals.listen((all) => all.t1?.title && titled.push(all.t1.title));

    // Assert
    expect([terminal.chatFallback, terminal.waiting], 'offers the chat; says what waits').to.deep.equal([true, 1]);

    // Act
    fire(terminal, 'acp-terminal-title', { terminalId: 't1', title: 'vim' });
    fire(terminal, 'acp-terminal-chat', {});
    fire(terminal, 'acp-terminal-restart', { terminalId: 't1' });
    await new Promise((r) => setTimeout(r, 20));

    // Assert
    expect(views, 'back to the chat').to.deep.equal([{ sessionId: 's1', view: 'chat' }]);
    expect(calls, 'the session restarts its CLI').to.include('session_open_cli');
    unsubscribe();
    expect(titled, 'a session terminal is not titled by its shell').to.deep.equal([]);

    // Act: a running CLI
    $terminals.set({ t1: running });
    await el.updateComplete;
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(terminal) });

    // Assert: the session's input pastes it, once the CLI runs
    expect(pasted).to.deep.equal([]);
  });
});
