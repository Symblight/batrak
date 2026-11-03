import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectTerminalPanels, $projectTerminalTabs, $terminalFocus, $terminalPanel, $terminalTabs, $terminals, focusTerminal, forgetTerminal, openTerminal } from '../../../stores/terminals/terminals.js';
import { $project } from '../../../stores/project/project.js';
import { tabs } from '../../../hooks/tabs/tabs.js';
import '../terminals-view.js';

/** @typedef {import('../terminals-view.js').AcpTerminalsView} AcpTerminalsView */

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 150 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).to.equal(true);
}

describe('acp-terminals-view', () => {
  beforeEach(() => {
    mockIPC((cmd) => (cmd === 'terminal_open' ? { shell: 'zsh', cwd: '/p' } : null));
    $project.set({ path: '/p', name: 'p', rootId: null });
  });

  afterEach(() => {
    for (const id of Object.keys($terminals.get())) forgetTerminal(id);
    $projectTerminalTabs.set({});
    $projectTerminalPanels.set({});
    $terminalFocus.set(null);
    $project.set(null);
    clearMocks();
  });

  /** @returns {Promise<AcpTerminalsView>} */
  async function render() {
    return /** @type {AcpTerminalsView} */ (await fixture(html`<acp-terminals-view></acp-terminals-view>`));
  }

  const tabView = (/** @type {AcpTerminalsView} */ el) => /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (el.querySelector('acp-tab-view'));
  /** The terminal views the tab view mounted, in tab order. */
  const views = (/** @type {AcpTerminalsView} */ el) => [...(tabView(el).shadowRoot?.querySelectorAll('acp-terminal-view') ?? [])];
  const mounted = (/** @type {AcpTerminalsView} */ el) => views(el).map((v) => v.getAttribute('terminal-id'));

  it('shows the shown project’s terminals, every one mounted and the active one in front, and swaps them with the project', async () => {
    // Arrange
    const a = openTerminal('/p', '/p', 'a');
    const b = openTerminal('/p', '/p', 'b');
    const el = await render();

    // Assert
    expect(mounted(el)).to.deep.equal([a, b]);
    expect(tabView(el).active).to.equal(tabs.terminalId(b));
    expect(tabView(el).tabs.map((t) => t.kind)).to.deep.equal(['terminal', 'terminal']);

    // Act: another project, with a terminal of its own, then back
    $project.set({ path: '/q', name: 'q', rootId: null });
    const c = openTerminal('/q', '/q', 'c');
    await el.updateComplete;
    const other = mounted(el);
    $project.set({ path: '/p', name: 'p', rootId: null });
    await el.updateComplete;

    // Assert
    expect(other).to.deep.equal([c]);
    expect(mounted(el), 'as it was').to.deep.equal([a, b]);
    expect(tabView(el).active).to.equal(tabs.terminalId(b));
  });

  it('adds a terminal with + and hides the panel with −, which keeps its terminals', async () => {
    // Arrange
    const first = openTerminal('/p', '/p', 'a');
    const el = await render();
    const [add, hide] = /** @type {HTMLElement[]} */ ([...el.querySelectorAll('acp-terminal-action')]);

    // Act
    add.dispatchEvent(new CustomEvent('acp-terminal-new', { bubbles: true, composed: true }));
    await until(() => $terminalTabs.get().paths.length === 2);
    hide.dispatchEvent(new CustomEvent('acp-terminal-hide', { bubbles: true, composed: true }));
    await el.updateComplete;

    // Assert
    expect($terminalPanel.get().open).to.equal(false);
    expect($terminalTabs.get().paths[0]).to.equal(tabs.terminalId(first));
    expect(mounted(el), 'still mounted').to.have.length(2);
  });

  it('turns the strip’s events into the terminal group’s actions: activate, reorder, pin and close', async () => {
    // Arrange
    const [a, b, c] = ['a', 'b', 'c'].map((label) => openTerminal('/p', '/p', label));
    const [ta, tb, tc] = [a, b, c].map(tabs.terminalId);
    const el = await render();
    const send = (/** @type {string} */ type, /** @type {object} */ detail) => tabView(el).dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

    // Act + Assert
    send('acp-tab-activate', { id: ta });
    expect($terminalTabs.get().active).to.equal(ta);
    send('acp-tab-move', { id: ta, index: 2 });
    expect($terminalTabs.get().paths).to.deep.equal([tb, tc, ta]);
    send('acp-tab-pin', { id: tc, pinned: true });
    expect($terminalTabs.get().pinned).to.deep.equal([tc]);
    send('acp-tab-close', { id: tb, scope: 'tab' });
    expect($terminalTabs.get().paths).to.deep.equal([tc, ta]);
    send('acp-tab-close', { id: ta, scope: 'others' });
    expect($terminalTabs.get().paths, 'the pinned stay').to.deep.equal([tc, ta]);
    send('acp-tab-close', { id: tc, scope: 'all' });
    expect($terminalTabs.get().paths).to.deep.equal([tc]);
  });

  it('focuses the terminal a request names, once it is mounted, and answers it', async () => {
    // Arrange
    const id = openTerminal('/p', '/p', 'a');
    const el = await render();
    const view = views(el)[0];
    /** @type {string[]} */
    const focused = [];
    view.focus = () => focused.push(/** @type {string} */ (view.getAttribute('terminal-id')));

    // Act
    focusTerminal(id);
    await until(() => $terminalFocus.get() === null);

    // Assert
    expect(focused).to.deep.equal([id]);
  });
});
