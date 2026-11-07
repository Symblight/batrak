import { tabs } from '../../../hooks/tabs/tabs.js';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fileBytes, fixture, html } from '../../../../test/fixture.js';
import { $activePath, closeAllTabs, openAgents, openChanges, openSettings, openTab } from '../../../stores/editor/editor.js';
import { $gitChanges } from '../../../stores/git/git.js';
import { $terminalFocus, $terminals } from '../../../stores/terminals/terminals.js';
import { AcpChangesReview } from '../../../components/changes-review/changes-review.js';
import { $project } from '../../../stores/project/project.js';
import { $markdownModes } from '../../../stores/markdown-view/markdown-view.js';
import { markdownView } from '../../../hooks/markdown-view/markdown-view.js';
import { app } from '../../../hooks/app/app.js';
import '../main-column.js';

/** @typedef {import('../main-column.js').AcpMainColumn} AcpMainColumn */
/** @typedef {import('../../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */

/** @type {TerminalInfo} */
const running = { cwd: '/p', fallback: '/p', label: 'zsh — p', title: null, folder: '/p', projectPath: '/p', status: 'running', exit: null, error: null, login: null };

describe('acp-main-column', () => {
  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd === 'agents_list') return { agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] };
      if (cmd === 'agents_view') return { installed: [], userAgents: [], registry: [], counts: { all: 0, updates: 0, off: 0 }, defaultAgent: null, errors: [], registryState: { checkedAt: null, offline: false, checking: false } };
      return null;
    });
    $project.set({ path: '/p', name: 'p', rootId: null });
    $terminals.set({ t1: running });
  });

  afterEach(() => {
    closeAllTabs();
    $terminals.set({});
    $gitChanges.set({ files: [], loaded: false, loading: false, error: null });
    $project.set(null);
    clearMocks();
  });

  async function render() {
    const el = /** @type {AcpMainColumn} */ (await fixture(html`<acp-main-column style="display: flex; width: 800px; height: 500px"></acp-main-column>`));
    const tabView = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (el.querySelector('acp-tab-view'));
    await tabView.updateComplete;
    return { el, tabView };
  }

  it('gives the keyboard to a terminal whose tab is clicked, and asks nothing for a file', async () => {
    // Arrange
    const { tabView } = await render();
    const click = (/** @type {string} */ id) => tabView.dispatchEvent(new CustomEvent('acp-tab-activate', { detail: { id }, bubbles: true, composed: true }));
    // Act
    click('/p/a.js');
    // Assert
    expect($terminalFocus.get(), 'a file').to.equal(null);
    // Act
    click(tabs.terminalId('t1'));
    // Assert
    expect($terminalFocus.get()).to.deep.equal({ terminalId: 't1' });
    $terminalFocus.set(null);
  });

  it('hands its tab view a dialog of its own to ask in', async () => {
    // Arrange + Act
    const { el } = await render();

    // Assert
    const dialog = el.querySelector('acp-confirm-dialog');
    expect(dialog).to.exist;
    expect(/** @type {HTMLElementTagNameMap['acp-tab-view']} */ (el.querySelector('acp-tab-view')).confirmDialog()).to.equal(dialog);
  });

  it('shows the Settings, Agents, Changes and terminal tabs through their views', async () => {
    // Arrange
    openTab(tabs.terminalId('t1'));
    openTab(tabs.workspaceChangesId('w1'));
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
    expect(tabView.shadowRoot?.querySelector('acp-workspace-changes-tab')?.workspaceId, 'and a workspace’s Changes tab').to.equal('w1');
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
    mockIPC((cmd) => (cmd === 'read_file' ? fileBytes('first\nsecond needle\n') : null));
    // Files are read only once the project's root is open.
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    const { el } = await render();
    el.openFile('/p/a.txt', { line: 2, column: 8, length: 6 });
    const started = Date.now();
    while (el.selectedText() !== 'needle') {
      expect(Date.now() - started, 'timed out').to.be.lessThan(1500);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(el.querySelector('acp-tab-view')?.shadowRoot?.querySelector('acp-editor-view acp-code-view'), 'through the editor view').to.not.equal(null);
  });

  it("answers a file tab's Open in itself: shows it in the file manager, starts a terminal in its folder", async () => {
    // Arrange
    /** @type {{ cmd: string, args: unknown }[]} */
    const calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return null;
    });
    $terminals.set({});
    const { el, tabView } = await render();
    /** @type {string[]} */
    const escaped = [];
    const parent = /** @type {HTMLElement} */ (el.parentElement);
    const note = (/** @type {Event} */ e) => escaped.push(e.type);
    const types = ['acp-reveal-path', 'acp-open-terminal'];
    for (const type of types) parent.addEventListener(type, note);
    /** @param {string} type @param {object} detail */
    const ask = (type, detail) => tabView.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    try {
      // Act
      ask('acp-reveal-path', { path: '/p/src/a.js' });
      ask('acp-open-terminal', { path: '/p/src' });
      // Assert
      expect(calls.filter((c) => c.cmd === 'reveal_path').map((c) => c.args)).to.deep.equal([{ path: '/p/src/a.js' }]);
      expect(Object.values($terminals.get()).map((t) => t.cwd)).to.deep.equal(['/p/src']);
      expect(escaped, 'not answered again above the column').to.deep.equal([]);
    } finally {
      for (const type of types) parent.removeEventListener(type, note);
    }
  });

  describe('markdown view keys', () => {
    afterEach(() => $markdownModes.setKey('/p', undefined));

    /**
     * @param {Element} target
     * @param {KeyboardEventInit} init
     */
    function press(target, init) {
      const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    }
    const mode = () => markdownView.modeOf('/p/docs/a.md');
    /** The platform's Mod held. */
    const mod = { [app.platform === 'mac' ? 'metaKey' : 'ctrlKey']: true };

    it('toggles Preview with Mod+Shift+V, from Raw and from Split', async () => {
      openTab('/p/docs/a.md');
      const { tabView } = await render();

      const first = press(tabView, { key: 'V', code: 'KeyV', ...mod, shiftKey: true });
      expect([mode(), first.defaultPrevented]).to.deep.equal(['preview', true]);
      press(tabView, { key: 'v', code: 'KeyV', ...mod, shiftKey: true });
      expect(mode()).to.equal('raw');

      markdownView.setMode('/p/docs/a.md', 'split');
      press(tabView, { key: 'V', code: 'KeyV', ...mod, shiftKey: true });
      expect(mode()).to.equal('preview');
    });

    it('toggles Split with Mod+K, then V', async () => {
      openTab('/p/docs/a.md');
      const { tabView } = await render();

      const chord = press(tabView, { key: 'k', code: 'KeyK', ...mod });
      const second = press(tabView, { key: 'v', code: 'KeyV' });
      expect([mode(), chord.defaultPrevented, second.defaultPrevented]).to.deep.equal(['split', true, true]);

      press(tabView, { key: 'k', code: 'KeyK', ...mod });
      press(tabView, { key: 'v', code: 'KeyV', ...mod });
      expect(mode(), 'with Mod still held').to.equal('raw');

      press(tabView, { key: 'л', code: 'KeyK', ...mod });
      press(tabView, { key: 'м', code: 'KeyV' });
      expect(mode(), 'by position on a non-Latin layout').to.equal('split');
    });

    it('drops the chord at any other key, which is not swallowed, and when it waited too long', async () => {
      openTab('/p/docs/a.md');
      const { tabView } = await render();

      press(tabView, { key: 'k', code: 'KeyK', ...mod });
      press(tabView, { key: 'Shift', shiftKey: true });
      const other = press(tabView, { key: 'x', code: 'KeyX' });
      press(tabView, { key: 'v', code: 'KeyV' });
      expect([mode(), other.defaultPrevented], 'cancelled').to.deep.equal(['raw', false]);

      press(tabView, { key: 'k', code: 'KeyK', ...mod });
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const late = press(tabView, { key: 'v', code: 'KeyV' });
      expect([mode(), late.defaultPrevented], 'too late').to.deep.equal(['raw', false]);
    });

    it('goes back from Preview to Raw with Esc, unless something is selected', async () => {
      openTab('/p/docs/a.md');
      const { tabView } = await render();
      const content = /** @type {HTMLElement} */ (tabView.shadowRoot?.querySelector('.acp-tab-view__panel[active]'));
      markdownView.setMode('/p/docs/a.md', 'preview');
      const host = document.createElement('p');
      host.textContent = 'some text';
      document.body.append(host);
      getSelection()?.selectAllChildren(host);

      press(content, { key: 'Escape' });
      expect(mode(), 'with a selection').to.equal('preview');

      getSelection()?.removeAllRanges();
      host.remove();
      const esc = press(content, { key: 'Escape' });
      expect([mode(), esc.defaultPrevented]).to.deep.equal(['raw', true]);

      const again = press(content, { key: 'Escape' });
      expect(again.defaultPrevented, 'not in Preview').to.equal(false);
    });

    it('leaves Esc to a dialog of the tab view, which is not in the file’s panel', async () => {
      openTab('/p/docs/a.md');
      const { tabView } = await render();
      markdownView.setMode('/p/docs/a.md', 'preview');

      const esc = press(tabView, { key: 'Escape' });

      expect([mode(), esc.defaultPrevented]).to.deep.equal(['preview', false]);
    });

    it('leaves the keys alone for any other tab', async () => {
      openTab('/p/a.js');
      const { tabView } = await render();

      const events = [
        press(tabView, { key: 'V', code: 'KeyV', ...mod, shiftKey: true }),
        press(tabView, { key: 'k', code: 'KeyK', ...mod }),
        press(tabView, { key: 'v', code: 'KeyV' }),
      ];

      expect(events.map((e) => e.defaultPrevented)).to.deep.equal([false, false, false]);
      expect($markdownModes.get()['/p']).to.equal(undefined);
    });
  });
});
