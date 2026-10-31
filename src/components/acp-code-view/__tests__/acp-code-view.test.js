import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-code-view.js';

/** @typedef {import('../../../models/types/types.js').EditorTab} EditorTab */

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

describe('acp-code-view', () => {
  it('says when a file was deleted on disk, still showing it', async () => {
    const path = '/p/.brama/agents.json';
    /** @type {EditorTab} */
    const tab = { ...fileTab(path), loaded: true, content: '{}', deletedOnDisk: true };
    const el = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (
      await fixture(html`<acp-code-view .tab=${tab} .root=${'/p'}></acp-code-view>`)
    );
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-code-view__notice')?.textContent).to.match(/deleted on disk/i);
    expect(root.querySelector('cdx-code-editor')).to.exist;
    el.tab = { ...tab, deletedOnDisk: false };
    await el.updateComplete;
    expect(root.querySelector('.acp-code-view__notice')).to.equal(null);
  });

  describe('Mod+S', () => {
    const path = '/p/.brama/agents.json';

    /** @param {Partial<EditorTab>} props */
    async function save(props) {
      const tab = { ...fileTab(path), loaded: true, content: '{}', draft: '{ "x": 1 }', ...props };
      const el = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (
        await fixture(html`<acp-code-view .tab=${tab} .root=${'/p'}></acp-code-view>`)
      );
      /** @type {{ type: string, detail: unknown }[]} */
      const fired = [];
      for (const type of ['acp-tab-save', 'acp-tab-conflict']) {
        el.addEventListener(type, (e) => fired.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
      }
      el.shadowRoot
        ?.querySelector('cdx-code-editor')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, composed: true }));
      return fired;
    }

    it('saves an editable file', async () => {
      expect(await save({})).to.deep.equal([{ type: 'acp-tab-save', detail: { id: path } }]);
    });

    it('reports a conflict instead when the file changed on disk', async () => {
      expect(await save({ changedOnDisk: true })).to.deep.equal([{ type: 'acp-tab-conflict', detail: { id: path } }]);
    });
  });

  describe('footer menus', () => {
    /**
     * @param {HTMLElement} el
     * @param {string} item
     * @param {number} [index]
     */
    const clickStatus = async (el, item, index) => {
      const editor = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('cdx-code-editor'));
      editor.dispatchEvent(new CustomEvent('cdx-status-click', { detail: { item, index }, bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 50));
    };

    /**
     * Chooses an item of the menu open from the footer.
     * @param {HTMLElement} el
     * @param {string} menuClass
     * @param {string} value
     */
    const choose = (el, menuClass, value) => {
      const menu = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector(`.${menuClass}`));
      const item = menu.querySelector(`md-menu-item[value="${CSS.escape(value)}"]`);
      expect(item, `item ${value}`).to.exist;
      menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
    };

    /**
     * @param {HTMLElement} el
     * @param {string} type
     */
    const listen = (el, type) => {
      /** @type {unknown[]} */
      const details = [];
      el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
      return details;
    };

    const file = '/work/app/src/lib/main.js';

    /** @param {object} [props] */
    /** @type {Record<string, { name: string, path: string, isDir: boolean, ignored: boolean }[]>} */
    const folders = {
      '': [
        { name: 'node_modules', path: 'node_modules', isDir: true, ignored: true },
        { name: 'src', path: 'src', isDir: true, ignored: false },
        { name: 'package.json', path: 'package.json', isDir: false, ignored: false },
      ],
      'src/lib': [{ name: 'main.js', path: 'src/lib/main.js', isDir: false, ignored: false }],
    };
    /** @type {[string, string][]} */
    let listed = [];
    /**
     * @param {string} rootId
     * @param {string} rel
     */
    const listDir = async (rootId, rel) => {
      listed.push([rootId, rel]);
      return (folders[rel] ?? []).map((e) => ({ ...e, size: 0, mtime: 0 }));
    };

    /** @param {object} [props] */
    const render = (props = {}) => {
      listed = [];
      return fixture(html`<acp-code-view
        .tab=${fileTab(file)}
        .root=${'/work/app'}
        .rootId=${'r1'}
        .listDir=${listDir}
        .worktrees=${/** @type {any} */ (props).worktrees ?? []}
        .language=${/** @type {any} */ (props).language ?? ''}
      ></acp-code-view>`);
    };

    it('opens a language menu from the footer and picks a language for the file', async () => {
      const el = await render();
      await clickStatus(el, 'language');
      const menu = el.shadowRoot.querySelector('.acp-code-view__language-menu');
      expect(menu.open).to.be.true;
      expect(menu.querySelector('md-menu-item[value="Python"]')).to.exist;
      const picks = listen(el, 'acp-tab-language');
      choose(el, 'acp-code-view__language-menu', 'Python');
      expect(picks).to.deep.equal([{ path: file, language: 'Python' }]);
    });

    it('goes back to the detected language with Auto Detect', async () => {
      const el = await render({ language: 'Python' });
      await clickStatus(el, 'language');
      const picks = listen(el, 'acp-tab-language');
      choose(el, 'acp-code-view__language-menu', '');
      expect(picks).to.deep.equal([{ path: file, language: '' }]);
    });

    it("sets the editor's language to the file's pick", async () => {
      const el = await render({ language: 'Python' });
      expect(el.shadowRoot.querySelector('cdx-code-editor').language).to.equal('Python');
    });

    it('opens a file menu from the file crumb', async () => {
      const el = await render();
      await clickStatus(el, 'file');
      expect(el.shadowRoot.querySelector('.acp-code-view__file-menu').open).to.be.true;
      const reveals = listen(el, 'acp-file-reveal');
      const copies = listen(el, 'acp-copy-path');
      choose(el, 'acp-code-view__file-menu', 'reveal');
      choose(el, 'acp-code-view__file-menu', 'copy-path');
      choose(el, 'acp-code-view__file-menu', 'copy-relative-path');
      expect(reveals).to.deep.equal([{ path: file, expand: false }]);
      expect(copies).to.deep.equal([{ path: file }, { path: 'src/lib/main.js' }]);
    });

    it("leads the footer's path with the project's folder", async () => {
      const el = await render();
      expect(el.shadowRoot.querySelector('cdx-footer').getAttribute('path')).to.equal('app/src/lib/main.js');
    });

    it("lists a path crumb's folder, the next one on the path selected", async () => {
      const el = await render();
      await clickStatus(el, 'path', 0);
      expect(listed).to.deep.equal([['r1', '']]);
      const menu = el.shadowRoot.querySelector('.acp-code-view__folder-menu');
      expect(menu.open).to.be.true;
      const items = [...menu.querySelectorAll('md-menu-item')];
      expect(items.map((i) => i.getAttribute('value'))).to.deep.equal(['node_modules', 'src', 'package.json']);
      expect(items.filter((i) => i.hasAttribute('selected')).map((i) => i.getAttribute('value'))).to.deep.equal(['src']);
    });

    it("selects the file itself in its own folder's list", async () => {
      const el = await render();
      await clickStatus(el, 'path', 2);
      expect(listed).to.deep.equal([['r1', 'src/lib']]);
      const selected = el.shadowRoot.querySelector('.acp-code-view__folder-menu md-menu-item[selected]');
      expect(selected?.getAttribute('value')).to.equal('src/lib/main.js');
    });

    it('opens a file and reveals a folder picked in a crumb\'s list', async () => {
      const el = await render();
      await clickStatus(el, 'path', 0);
      const opens = listen(el, 'acp-file-open');
      const reveals = listen(el, 'acp-file-reveal');
      choose(el, 'acp-code-view__folder-menu', 'package.json');
      choose(el, 'acp-code-view__folder-menu', 'src');
      expect(opens).to.deep.equal([{ path: '/work/app/package.json' }]);
      expect(reveals).to.deep.equal([{ path: '/work/app/src', expand: true }]);
    });

    it("reveals a worktree session's file as the project's same file", async () => {
      const folder = '/data/worktrees/app-1/s1';
      const wtFile = `${folder}/src/main.js`;
      const el = await fixture(html`<acp-code-view
        .tab=${fileTab(wtFile)}
        .root=${'/work/app'}
        .worktrees=${[{ sessionId: 's1', projectId: '/work/app', folder, branch: 'brama/x', title: 'X' }]}
      ></acp-code-view>`);
      await clickStatus(el, 'path', 0);
      const reveals = listen(el, 'acp-file-reveal');
      choose(el, 'acp-code-view__file-menu', 'reveal');
      expect(reveals).to.deep.equal([{ path: '/work/app/src', expand: true }]);
    });
  });

  describe('revealLine', () => {
    const path = '/p/a.js';
    const content = 'one\n  two foo bar\nthree';

    async function render() {
      const tab = { ...fileTab(path), loaded: true, content };
      const el = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (
        await fixture(html`<acp-code-view .tab=${tab} .root=${'/p'}></acp-code-view>`)
      );
      const editor = /** @type {HTMLElementTagNameMap['cdx-code-editor']} */ (el.shadowRoot?.querySelector('cdx-code-editor'));
      return { el, editor };
    }

    it('selects a match by its line, 1-based column and length', async () => {
      const { el, editor } = await render();
      await el.revealLine({ line: 2, column: 7, length: 3 });
      expect(editor.selection.getText()).to.equal('foo');
      expect(el.selectedText()).to.equal('foo');
      expect(editor.selection.getCursor()).to.deep.equal({ line: 2, column: 10 });
    });

    it('puts the caret on a plain line, selecting nothing', async () => {
      const { el, editor } = await render();
      await el.revealLine({ line: 2, column: 7, length: 3 });
      await el.revealLine(3);
      expect(el.selectedText()).to.equal('');
      expect(editor.selection.getCursor()?.line).to.equal(3);
    });
  });
});
