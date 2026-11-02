import { expect, fixture, html } from '../../../../test/fixture.js';
import '../markdown-view.js';

/** @typedef {import('../markdown-view.js').AcpMarkdownView} AcpMarkdownView */
/** @typedef {import('../../../hooks/tabs/types.js').EditorTab} EditorTab */

const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

/**
 * @param {Partial<EditorTab>} [extra]
 * @returns {EditorTab}
 */
const tab = (extra = {}) => ({
  id: '/p/docs/a.md',
  kind: 'file',
  path: '/p/docs/a.md',
  content: '# Title\n\nbody text',
  error: '',
  loaded: true,
  image: null,
  baseline: null,
  draft: null,
  changedOnDisk: false,
  deletedOnDisk: false,
  ...extra,
});

/**
 * @param {Partial<{ tab: EditorTab, mode: string, scrollSync: boolean, ratio: number }>} [props]
 * @returns {Promise<AcpMarkdownView>}
 */
const view = async ({ tab: t = tab(), mode = 'raw', scrollSync = true, ratio = 50 } = {}) => {
  const el = await fixture(
    html`<div style="display: flex; width: 900px; height: 400px">
      <acp-markdown-view .tab=${t} .mode=${mode} .scrollSync=${scrollSync} .ratio=${ratio} .root=${'/p'}></acp-markdown-view>
    </div>`,
  );
  const inner = /** @type {AcpMarkdownView} */ (el.firstElementChild);
  await inner.updateComplete;
  return inner;
};

/** @param {AcpMarkdownView} el */
const root = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);
/** @param {AcpMarkdownView} el */
const panes = (el) => [...root(el).querySelectorAll('acp-pane')];
/** @param {AcpMarkdownView} el */
const preview = (el) => root(el).querySelector('acp-markdown');
/** @param {AcpMarkdownView} el @param {string} selector */
const inPreview = (el, selector) => preview(el)?.shadowRoot?.querySelector(selector) ?? null;

/**
 * @param {AcpMarkdownView} el
 * @param {string} type
 */
function listen(el, type) {
  /** @type {unknown[]} */
  const heard = [];
  el.addEventListener(type, (e) => heard.push(/** @type {CustomEvent} */ (e).detail));
  return heard;
}

describe('acp-markdown-view', () => {
  describe('the three views', () => {
    it('shows the editor alone in Raw, without rendering the preview', async () => {
      const el = await view({ mode: 'raw' });

      expect(panes(el).map((p) => p.hidden)).to.deep.equal([false, true]);
      expect(preview(el)).to.equal(null);
    });

    it('shows the editor and the preview side by side in Split', async () => {
      const el = await view({ mode: 'split' });

      expect(panes(el).map((p) => p.hidden)).to.deep.equal([false, false]);
      expect(inPreview(el, 'h1')?.textContent).to.equal('Title');
    });

    it('shows the preview alone in Preview, the editor hidden and not gone', async () => {
      const el = await view({ mode: 'split' });
      const editor = root(el).querySelector('acp-code-view');
      const editorPane = panes(el)[0];

      el.mode = 'preview';
      await el.updateComplete;
      expect(panes(el).map((p) => p.hidden)).to.deep.equal([true, false]);
      expect(root(el).querySelector('acp-code-view')).to.equal(editor);

      el.mode = 'raw';
      await el.updateComplete;
      el.mode = 'split';
      await el.updateComplete;
      expect(root(el).querySelector('acp-code-view')).to.equal(editor);
      expect(panes(el)[0]).to.equal(editorPane);
    });

    it('lets the editor keep its unsaved text through a round trip', async () => {
      const el = await view({ mode: 'split', tab: tab({ draft: '# Draft\n\nunsaved' }) });
      const editor = /** @type {any} */ (root(el).querySelector('acp-code-view')?.shadowRoot?.querySelector('cdx-code-editor'));

      el.mode = 'preview';
      await el.updateComplete;
      el.mode = 'split';
      await el.updateComplete;

      expect(editor.value).to.equal('# Draft\n\nunsaved');
    });

    it('puts the switcher in a bar above the panes, not over them', async () => {
      const el = await view({ mode: 'split' });
      const bar = /** @type {HTMLElement} */ (root(el).querySelector('acp-markdown-switcher')?.parentElement);

      expect(bar.className).to.equal('acp-markdown-view__bar');
      expect(bar.nextElementSibling?.className).to.equal('acp-markdown-view__split');
    });

    it('shows the switcher on top, with the view that is shown', async () => {
      const el = await view({ mode: 'split', scrollSync: false });
      const switcher = /** @type {import('../../markdown-switcher/markdown-switcher.js').AcpMarkdownSwitcher} */ (root(el).querySelector('acp-markdown-switcher'));

      expect([switcher.mode, switcher.scrollSync]).to.deep.equal(['split', false]);
    });

    it('asks, with the tab, for the view and the sync the switcher asks for', async () => {
      const el = await view({ mode: 'raw' });
      const modes = listen(el, 'acp-markdown-mode');
      const syncs = listen(el, 'acp-markdown-sync');
      const switcher = /** @type {HTMLElement} */ (root(el).querySelector('acp-markdown-switcher'));

      switcher.dispatchEvent(new CustomEvent('acp-markdown-mode', { detail: { mode: 'split' }, bubbles: true, composed: true }));
      switcher.dispatchEvent(new CustomEvent('acp-markdown-sync', { detail: { on: false }, bubbles: true, composed: true }));

      expect(modes).to.deep.equal([{ id: '/p/docs/a.md', mode: 'split' }]);
      expect(syncs).to.deep.equal([{ on: false }]);
    });
  });

  describe('what the preview shows', () => {
    it('shows the unsaved text over the file’s', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: '# Disk', draft: '# Typed' }) });

      expect(inPreview(el, 'h1')?.textContent).to.equal('Typed');
    });

    it('shows nothing for a file not read yet', async () => {
      const el = await view({ mode: 'split', tab: tab({ loaded: false, content: '' }) });

      expect(inPreview(el, 'h1')).to.equal(null);
    });

    it('renders the file as a document: relative links resolve against its folder', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: '[next](other.md)' }) });
      const heard = listen(el, 'acp-file-open');

      /** @type {HTMLElement} */ (inPreview(el, 'a')).click();

      expect(heard).to.deep.equal([{ path: '/p/docs/other.md' }]);
    });

    it('follows the typing a moment after it stops, and shows the first text at once', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: 'one' }) });
      expect(inPreview(el, 'p')?.textContent).to.equal('one');

      el.tab = tab({ content: 'one', draft: 'two' });
      await el.updateComplete;
      await wait(40);
      el.tab = tab({ content: 'one', draft: 'three' });
      await el.updateComplete;
      await wait(60);
      expect(inPreview(el, 'p')?.textContent, 'still waiting').to.equal('one');

      await wait(250);
      expect(inPreview(el, 'p')?.textContent).to.equal('three');
    });

    it('shows another file’s text at once when the tab changes', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: 'one' }) });

      el.tab = tab({ id: '/p/b.md', path: '/p/b.md', content: 'other file' });
      await el.updateComplete;
      await frame();

      expect(inPreview(el, 'p')?.textContent).to.equal('other file');
    });

    it('waits longer over a file of more than a megabyte, saying it is rendering', async () => {
      const big = `${'x'.repeat(1_000_100)}`;
      const el = await view({ mode: 'split', tab: tab({ content: 'small' }) });
      const note = () => root(el).querySelector('.acp-markdown-view__rendering');
      expect(note()).to.equal(null);

      el.tab = tab({ content: big });
      await el.updateComplete;
      await wait(300);
      expect(note()?.textContent?.trim(), 'while it waits').to.equal('Rendering…');
      expect(inPreview(el, 'p')?.textContent).to.equal('small');

      for (let i = 0; i < 30 && note(); i++) {
        await wait(100);
        await el.updateComplete;
      }
      expect(note()).to.equal(null);
      await frame();
      await frame();
      expect(inPreview(el, 'p')?.textContent?.length).to.equal(big.length);
    });
  });

  describe('a file of more than a megabyte, shown for the first time', () => {
    it('waits to render it too, the editor already usable', async () => {
      const big = 'x'.repeat(1_000_100);
      const el = await view({ mode: 'split', tab: tab({ content: big }) });
      const note = () => root(el).querySelector('.acp-markdown-view__rendering');

      expect(note()?.textContent?.trim()).to.equal('Rendering…');
      expect(inPreview(el, 'p')).to.equal(null);
      expect(root(el).querySelector('acp-code-view')).to.not.equal(null);

      for (let i = 0; i < 40 && note(); i++) {
        await wait(100);
        await el.updateComplete;
      }
      await frame();
      await frame();
      expect(note()).to.equal(null);
      expect(inPreview(el, 'p')?.textContent?.length).to.equal(big.length);
    });
  });

  describe('the divider', () => {
    /**
     * @param {AcpMarkdownView} el
     * @param {string} type
     * @param {object} detail
     */
    function fire(el, type, detail) {
      const handle = /** @type {HTMLElement} */ (root(el).querySelector('acp-resize-handle'));
      handle.dispatchEvent(new CustomEvent(type, { detail: { name: 'markdown', ...detail }, bubbles: true, composed: true }));
    }
    const measure = { width: 400, neighborWidth: 400, neighborMin: 0 };

    it('sizes the panes by the ratio', async () => {
      const el = await view({ mode: 'split', ratio: 30 });

      const [editor, rendered] = panes(el);
      expect([getComputedStyle(editor).flexGrow, getComputedStyle(rendered).flexGrow]).to.deep.equal(['30', '70']);
    });

    it('moves with the drag and reports the ratio where it ends', async () => {
      const el = await view({ mode: 'split', ratio: 50 });
      const heard = listen(el, 'acp-markdown-ratio');

      fire(el, 'acp-resize-start', { measure });
      fire(el, 'acp-resize', { delta: -160 });
      await el.updateComplete;
      expect(getComputedStyle(panes(el)[0]).flexGrow, 'live').to.equal('30');
      expect(heard, 'nothing stored while dragging').to.deep.equal([]);

      fire(el, 'acp-resize-end', {});
      expect(heard).to.deep.equal([{ ratio: 30 }]);
    });

    it('keeps the editor between a fifth and four fifths', async () => {
      const el = await view({ mode: 'split' });
      const heard = listen(el, 'acp-markdown-ratio');

      fire(el, 'acp-resize-start', { measure });
      fire(el, 'acp-resize', { delta: -9999 });
      fire(el, 'acp-resize-end', {});
      fire(el, 'acp-resize-start', { measure });
      fire(el, 'acp-resize', { delta: 9999 });
      fire(el, 'acp-resize-end', {});

      expect(heard).to.deep.equal([{ ratio: 20 }, { ratio: 80 }]);
    });

    it('steps from the keyboard, and goes back to half on a double-click', async () => {
      const el = await view({ mode: 'split', ratio: 60 });
      const heard = listen(el, 'acp-markdown-ratio');

      fire(el, 'acp-resize-step', { delta: 80, measure });
      fire(el, 'acp-resize-reset', {});

      expect(heard).to.deep.equal([{ ratio: 60 }, { ratio: 50 }]);
    });

    it('keeps the resize to itself', async () => {
      const el = await view({ mode: 'split' });
      const outside = listen(/** @type {AcpMarkdownView} */ (/** @type {unknown} */ (el.parentElement)), 'acp-resize-end');

      fire(el, 'acp-resize-end', {});

      expect(outside).to.deep.equal([]);
    });
  });

  describe('a double-click on the preview', () => {
    /** @param {AcpMarkdownView} el */
    function trackEditor(el) {
      const editor = /** @type {any} */ (root(el).querySelector('acp-code-view'));
      /** @type {unknown[]} */
      const revealed = [];
      editor.revealLine = (/** @type {unknown} */ at) => revealed.push(at);
      return revealed;
    }
    const dblclick = (/** @type {AcpMarkdownView} */ el) =>
      inPreview(el, 'p')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));

    it('puts the caret on the block’s first line in the editor', async () => {
      const el = await view({ mode: 'split' });
      const revealed = trackEditor(el);

      dblclick(el);

      expect(revealed).to.deep.equal([3]);
    });

    it('opens the editor first when only the preview is shown', async () => {
      const el = await view({ mode: 'preview' });
      const revealed = trackEditor(el);
      const modes = listen(el, 'acp-markdown-mode');

      dblclick(el);
      expect(modes).to.deep.equal([{ id: '/p/docs/a.md', mode: 'split' }]);
      expect(revealed, 'not yet: the editor is hidden').to.deep.equal([]);

      el.mode = 'split';
      await el.updateComplete;
      expect(revealed).to.deep.equal([3]);
    });
  });

  describe('for the host', () => {
    it('puts the caret on a line of the editor', async () => {
      const el = await view({ mode: 'split' });
      const editor = /** @type {any} */ (root(el).querySelector('acp-code-view'));
      /** @type {unknown[]} */
      const revealed = [];
      editor.revealLine = (/** @type {unknown} */ at) => revealed.push(at);

      el.revealLine(7);

      expect(revealed).to.deep.equal([7]);
    });

    it('says what is selected in the editor', async () => {
      const el = await view({ mode: 'split' });
      const editor = /** @type {any} */ (root(el).querySelector('acp-code-view'));
      editor.selectedText = () => 'picked';

      expect(el.selectedText()).to.equal('picked');
    });
  });

  describe('scrolling together (Split)', () => {
    const long = Array.from({ length: 150 }, (_, i) => `paragraph ${i + 1}`).join('\n\n');

    /** @param {AcpMarkdownView} el */
    async function panes2(el) {
      const code = /** @type {any} */ (root(el).querySelector('acp-code-view'));
      const editor = code.shadowRoot.querySelector('cdx-code-editor');
      await editor.updateComplete;
      for (let i = 0; i < 10 && !editor.view; i++) await wait(50);
      await el.updateComplete;
      await wait(100);
      return {
        editor: /** @type {HTMLElement} */ (editor.view.scrollDOM),
        preview: /** @type {HTMLElement} */ (root(el).querySelector('.acp-markdown-view__scroller')),
      };
    }

    it('brings the editor to the block the preview was scrolled to', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: long }) });
      const { editor, preview } = await panes2(el);

      preview.scrollTop = preview.scrollHeight / 2;
      await wait(300);

      expect(editor.scrollTop).to.be.greaterThan(500);
    });

    it('brings the preview to the block of the editor’s top line', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: long }) });
      const { editor, preview } = await panes2(el);

      editor.scrollTop = editor.scrollHeight / 2;
      await wait(300);

      expect(preview.scrollTop).to.be.greaterThan(500);
    });

    it('marks the block the editor is at', async () => {
      const el = await view({ mode: 'split', tab: tab({ content: long }) });
      const { editor } = await panes2(el);

      editor.scrollTop = editor.scrollHeight / 2;
      await wait(300);

      expect(inPreview(el, '.acp-markdown__block_current')?.textContent).to.match(/^paragraph \d+$/);
    });

    it('leaves the panes alone when switched off, and outside Split', async () => {
      const el = await view({ mode: 'split', scrollSync: false, tab: tab({ content: long }) });
      const { editor, preview } = await panes2(el);

      editor.scrollTop = editor.scrollHeight / 2;
      await wait(300);
      expect(preview.scrollTop, 'sync off').to.equal(0);

      el.scrollSync = true;
      el.mode = 'preview';
      await el.updateComplete;
      editor.scrollTop = 0;
      editor.scrollTop = 800;
      await wait(300);
      expect(preview.scrollTop, 'preview only').to.equal(0);
    });
  });
});
