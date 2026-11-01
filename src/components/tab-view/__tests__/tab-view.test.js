import { expect, fixture, html } from '../../../../test/fixture.js';
import '../tab-view.js';
import '../../code-view/code-view.js';

/** @typedef {import('../../../hooks/tabs/types.js').EditorTab} EditorTab */

/**
 * @param {string} path
 * @returns {EditorTab}
 */
const fileTab = (path) => ({
  id: path,
  kind: 'file',
  path,
  content: '',
  error: '',
  loaded: false,
  image: null,
  baseline: null,
  draft: null,
  changedOnDisk: false,
  deletedOnDisk: false,
});

/** What the main column renders for a file: its editor. */
const codeContent = (/** @type {EditorTab} */ tab) => html`<acp-code-view .tab=${tab}></acp-code-view>`;

/**
 * @param {string} terminalId
 * @returns {EditorTab}
 */
const terminalTab = (terminalId) => ({ ...fileTab(''), id: `view:terminal:${terminalId}`, kind: 'terminal' });

/** @type {import('../../../hooks/terminals/types.js').TerminalInfo} */
const terminalInfo = {
  cwd: '/p',
  fallback: '/p',
  label: 'zsh — p',
  title: null,
  projectPath: '/p',
  status: 'running',
  exit: null,
  error: null,
  login: null,
};

describe('acp-tab-view', () => {
  it('shows the Browser tab as a placeholder, which is not implemented yet', async () => {
    const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
      await fixture(html`<acp-tab-view .tabs=${[{ ...fileTab(''), id: 'view:browser', kind: 'browser' }]} .active=${'view:browser'}></acp-tab-view>`)
    );
    const placeholder = el.shadowRoot?.querySelector('acp-view-placeholder');
    expect(placeholder?.getAttribute('heading')).to.equal('Browser');
    expect(placeholder?.getAttribute('text')).to.equal('Not implemented yet.');
  });

  it('shows what its host renders for a view tab, one panel per tab and only the active one shown', async () => {
    // Arrange
    const tabs = [
      { ...fileTab(''), id: 'view:settings', kind: /** @type {const} */ ('settings') },
      { ...fileTab(''), id: 'view:agents', kind: /** @type {const} */ ('agents') },
      { ...fileTab(''), id: 'view:changes', kind: /** @type {const} */ ('changes') },
      { ...fileTab(''), id: 'view:session-changes:s1', kind: /** @type {const} */ ('session-changes') },
      terminalTab('t1'),
      { ...fileTab(''), id: 'view:browser', kind: /** @type {const} */ ('browser') },
    ];
    const asked = /** @type {string[]} */ ([]);
    const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
      await fixture(html`<acp-tab-view
        .tabs=${tabs}
        .active=${'view:settings'}
        .renderContent=${(/** @type {EditorTab} */ tab) => {
          asked.push(tab.id);
          return html`<p class="from-host">${tab.id}</p>`;
        }}
      ></acp-tab-view>`)
    );
    // Assert
    const panels = [...(el.shadowRoot?.querySelectorAll('.acp-tab-view__panel') ?? [])];
    expect(asked, 'asked for the host’s tabs only, not the placeholder').to.deep.equal(['view:settings', 'view:agents', 'view:changes', 'view:session-changes:s1', 'view:terminal:t1']);
    expect(panels[0].querySelector('.from-host')?.textContent).to.equal('view:settings');
    expect(panels.map((p) => p.hasAttribute('active'))).to.deep.equal([true, false, false, false, false, false]);
  });

  describe('terminal tabs', () => {
    /** @param {import('../../../hooks/terminals/types.js').TerminalBusy[]} busy */
    async function render(busy) {
      /** @type {string[][]} */
      const asked = [];
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view
          .tabs=${[terminalTab('t1')]}
          .active=${'view:terminal:t1'}
          .root=${'/p'}
          .terminals=${{ t1: terminalInfo }}
          .terminalBusy=${async (/** @type {string[]} */ ids) => {
            asked.push(ids);
            return busy;
          }}
        ></acp-tab-view>`)
      );
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      /** @type {unknown[]} */
      const closes = [];
      el.addEventListener('acp-tab-close', (e) => closes.push(/** @type {CustomEvent} */ (e).detail));
      const strip = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (root.querySelector('acp-tab-strip'));
      const close = () => /** @type {HTMLElement} */ (strip.shadowRoot?.querySelector('.acp-tab-strip__close')).click();
      const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
      return { el, root, asked, closes, close, dialog };
    }

    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('closes an idle terminal at once', async () => {
      const { asked, closes, close } = await render([]);
      close();
      await settle();
      expect(asked).to.deep.equal([['t1']]);
      expect(closes).to.deep.equal([{ id: 'view:terminal:t1', scope: 'tab' }]);
    });

    it('asks before closing a busy terminal; Cancel keeps it', async () => {
      const { closes, close, dialog } = await render([{ id: 't1', process: 'vim' }]);
      close();
      await settle();
      expect(dialog.options?.headline).to.equal('Terminate vim?');
      dialog.close();
      await settle();
      expect(closes).to.deep.equal([]);
    });
  });

  it('asks before closing a tab with unsaved edits; Cancel keeps it', async () => {
    const path = '/p/a.js';
    const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
      await fixture(html`<acp-tab-view .tabs=${[{ ...fileTab(path), draft: 'x' }]} .active=${path} .root=${'/p'} .renderContent=${codeContent}></acp-tab-view>`)
    );
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {unknown[]} */
    const closes = [];
    el.addEventListener('acp-tab-close', (e) => closes.push(/** @type {CustomEvent} */ (e).detail));
    const strip = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (root.querySelector('acp-tab-strip'));
    /** @type {HTMLElement} */ (strip.shadowRoot?.querySelector('.acp-tab-strip__close')).click();
    await new Promise((r) => setTimeout(r, 20));
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
    expect(dialog.options?.headline).to.equal('Discard unsaved changes?');
    dialog.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(closes).to.deep.equal([]);
  });

  describe('saving a file changed on disk', () => {
    const path = '/p/.brama/agents.json';
    /** @type {EditorTab} */
    const changed = { ...fileTab(path), loaded: true, content: '{}', draft: '{ "x": 1 }', changedOnDisk: true };

    /** @param {EditorTab} tab */
    async function render(tab) {
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view .tabs=${[tab]} .active=${path} .root=${'/p'} .renderContent=${codeContent}></acp-tab-view>`)
      );
      /** @type {{ type: string, detail: unknown }[]} */
      const fired = [];
      for (const type of ['acp-tab-save', 'acp-tab-reload']) {
        el.addEventListener(type, (e) => fired.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
      }
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
      /** @param {string} label */
      const click = async (label) => {
        await dialog.updateComplete;
        const actions = [...(dialog.shadowRoot?.querySelectorAll('.acp-confirm-dialog__action') ?? [])];
        /** @type {HTMLElement} */ (actions.find((a) => a.textContent?.trim() === label)).click();
        await new Promise((r) => setTimeout(r));
      };
      const save = () =>
        root
          .querySelector('acp-code-view')
          ?.shadowRoot?.querySelector('cdx-code-editor')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, composed: true }));
      return { el, fired, click, save };
    }

    it('saves at once when nothing changed on disk', async () => {
      const { fired, save } = await render({ ...changed, changedOnDisk: false });
      save();
      expect(fired).to.deep.equal([{ type: 'acp-tab-save', detail: { id: path } }]);
    });

    it('asks first, then overwrites or reloads as chosen', async () => {
      const { fired, click, save } = await render(changed);
      save();
      expect(fired, 'nothing before the answer').to.deep.equal([]);
      await click('Overwrite');
      expect(fired).to.deep.equal([{ type: 'acp-tab-save', detail: { id: path, force: true } }]);
      fired.length = 0;
      save();
      await click('Reload');
      expect(fired).to.deep.equal([{ type: 'acp-tab-reload', detail: { id: path } }]);
      fired.length = 0;
      save();
      await click('Cancel');
      expect(fired).to.deep.equal([]);
    });

    it('asks when the container found the change at save time', async () => {
      const { el, fired, click } = await render({ ...changed, changedOnDisk: false });
      el.confirmOverwrite(path);
      await click('Overwrite');
      expect(fired).to.deep.equal([{ type: 'acp-tab-save', detail: { id: path, force: true } }]);
    });
  });

  describe('revealLine', () => {
    const path = '/p/a.js';

    /** @param {HTMLElementTagNameMap['acp-tab-view']} el */
    const codeView = (el) => /** @type {HTMLElementTagNameMap['acp-code-view']} */ (el.shadowRoot?.querySelector('.acp-tab-view__panel[active] acp-code-view'));

    /**
     * Waits for the editor's selection to settle on `text`; fails after 2s.
     * @param {HTMLElementTagNameMap['acp-tab-view']} el
     * @param {string} text
     */
    async function untilSelected(el, text) {
      const started = Date.now();
      while (el.selectedText() !== text) {
        expect(Date.now() - started, `timed out waiting for "${text}"`).to.be.lessThan(2000);
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    it('selects a match in a tab once it is loaded', async () => {
      const tab = { ...fileTab(path), content: '' };
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view .tabs=${[tab]} .active=${path} .root=${'/p'} .renderContent=${codeContent}></acp-tab-view>`)
      );
      el.revealLine(path, { line: 2, column: 3, length: 6 });
      await el.updateComplete;
      expect(el.selectedText()).to.equal('');
      el.tabs = [{ ...tab, loaded: true, content: 'a\nb needle c' }];
      await untilSelected(el, 'needle');
      expect(codeView(el)).to.exist;
    });

    it('still takes a plain line', async () => {
      const tab = { ...fileTab(path), loaded: true, content: 'a\nb needle c\nd' };
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view .tabs=${[tab]} .active=${path} .root=${'/p'} .renderContent=${codeContent}></acp-tab-view>`)
      );
      el.revealLine(path, { line: 2, column: 3, length: 6 });
      await untilSelected(el, 'needle');
      el.revealLine(path, 3);
      await untilSelected(el, '');
      const editor = /** @type {HTMLElementTagNameMap['cdx-code-editor']} */ (codeView(el).shadowRoot?.querySelector('cdx-code-editor'));
      expect(editor.selection.getCursor()?.line).to.equal(3);
    });

    it('has no selected text without a code tab', async () => {
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (await fixture(html`<acp-tab-view></acp-tab-view>`));
      expect(el.selectedText()).to.equal('');
    });
  });
});
