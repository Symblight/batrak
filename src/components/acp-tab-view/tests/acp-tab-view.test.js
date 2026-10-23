import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-tab-view.js';

/** @typedef {import('../../../models/types.js').EditorTab} EditorTab */

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

/**
 * @param {string} terminalId
 * @returns {EditorTab}
 */
const terminalTab = (terminalId) => ({ ...fileTab(''), id: `view:terminal:${terminalId}`, kind: 'terminal' });

/** @type {import('../../../models/types.js').TerminalInfo} */
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
  describe('terminal tabs', () => {
    /** @param {import('../../../models/types.js').TerminalBusy[]} busy */
    async function render(busy) {
      /** @type {string[][]} */
      const asked = [];
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view
          .tabs=${[terminalTab('t1')]}
          .active=${'view:terminal:t1'}
          .root=${'/p'}
          .terminals=${{ t1: terminalInfo }}
          .terminalConnect=${() => ({ write() {}, resize() {}, dispose() {} })}
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

    it('shows its terminal', async () => {
      const { root } = await render([]);
      expect(root.querySelector('acp-terminal')?.terminalId).to.equal('t1');
    });

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
      await fixture(html`<acp-tab-view .tabs=${[{ ...fileTab(path), draft: 'x' }]} .active=${path} .root=${'/p'}></acp-tab-view>`)
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
        await fixture(html`<acp-tab-view .tabs=${[tab]} .active=${path} .root=${'/p'}></acp-tab-view>`)
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

});
