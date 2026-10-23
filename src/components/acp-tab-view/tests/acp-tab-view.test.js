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
      const close = () => /** @type {HTMLElement} */ (root.querySelector('.acp-tab-view__close')).click();
      const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
      return { el, root, asked, closes, close, dialog };
    }

    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('is titled from its terminal, or the title its shell set', async () => {
      const { el, root } = await render([]);
      const label = () => root.querySelector('.acp-tab-view__tab-label')?.textContent?.replace(/\s+/g, ' ').trim();
      expect(label()).to.include('zsh — p');
      el.terminals = { t1: { ...terminalInfo, title: 'vim a.txt' } };
      await el.updateComplete;
      expect(label()).to.include('vim a.txt');
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
          .querySelector('cdx-code-editor')
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

  it('says when a file was deleted on disk, still showing it', async () => {
    const path = '/p/.brama/agents.json';
    /** @type {EditorTab} */
    const tab = { ...fileTab(path), loaded: true, content: '{}', deletedOnDisk: true };
    const el = await fixture(html`<acp-tab-view .tabs=${[tab]} .active=${path} .root=${'/p'}></acp-tab-view>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-tab-view__notice')?.textContent).to.match(/deleted on disk/i);
    expect(root.querySelector('cdx-code-editor')).to.exist;
    el.tabs = [{ ...tab, deletedOnDisk: false }];
    await el.updateComplete;
    expect(root.querySelector('.acp-tab-view__notice')).to.equal(null);
  });

  it("shows a file tab's path relative to the project in its tooltip", async () => {
    const el = await fixture(html`<acp-tab-view
      .tabs=${[fileTab('/work/app/src/main.js')]}
      .root=${'/work/app'}
    ></acp-tab-view>`);
    expect(el.shadowRoot.querySelector('md-tooltip')?.textContent.trim()).to.equal('src/main.js');
  });

  it('keeps the absolute path for a file outside the project', async () => {
    const el = await fixture(html`<acp-tab-view
      .tabs=${[fileTab('/elsewhere/notes.md')]}
      .root=${'/work/app'}
    ></acp-tab-view>`);
    expect(el.shadowRoot.querySelector('md-tooltip')?.textContent.trim()).to.equal('/elsewhere/notes.md');
  });

  describe('Show Hidden Tabs', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `/p/src/file-number-${i}.js`);
    /** Lets the strip's observers measure it and the view render what they found. */
    const settle = async (/** @type {HTMLElementTagNameMap['acp-tab-view']} */ el) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;
    };

    /**
     * @param {{ width?: number, count?: number, active?: string, pinned?: string[], dirty?: string[] }} [props]
     */
    async function render({ width = 320, count = ids.length, active = ids[0], pinned = [], dirty = [] } = {}) {
      const tabs = ids.slice(0, count).map((id) => ({ ...fileTab(id), draft: dirty.includes(id) ? 'x' : null }));
      const el = /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (
        await fixture(html`<acp-tab-view
          style=${`width: ${width}px; height: 200px`}
          .tabs=${tabs}
          .active=${active}
          .pinned=${pinned}
          .root=${'/p'}
        ></acp-tab-view>`)
      );
      await settle(el);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const strip = /** @type {HTMLElement} */ (root.querySelector('.acp-tab-view__tab-strip'));
      strip.style.scrollBehavior = 'auto';
      const button = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-tab-view__overflow'));
      const menu = () => /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-tab-view__overflow-menu'));
      const rows = () => [...menu().querySelectorAll('.acp-tab-view__overflow-item')];
      const listed = () => rows().map((r) => r.getAttribute('value'));
      const open = async () => {
        /** @type {HTMLElement} */ (button()).click();
        await settle(el);
      };
      /** @param {string} type */
      const listen = (type) => {
        /** @type {unknown[]} */
        const details = [];
        el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
        return details;
      };
      /** @param {string} id */
      const closeRow = (id) =>
        /** @type {HTMLElement} */ (
          menu().querySelector(`.acp-tab-view__overflow-item[value="${CSS.escape(id)}"] .acp-tab-view__overflow-close`)
        ).click();
      return { el, root, strip, button, menu, rows, listed, open, listen, closeRow };
    }

    it('shows no button while the tabs fit', async () => {
      const { button } = await render({ width: 900, count: 2 });
      expect(button()).to.equal(null);
    });

    it("shows the button once they don't, and lists only the tabs out of view, in strip order", async () => {
      const { button, open, menu, listed } = await render();
      expect(button()).to.exist;
      expect(button()?.getAttribute('aria-label')).to.equal('Show Hidden Tabs');
      await open();
      expect(menu().open).to.be.true;
      const hidden = listed();
      expect(hidden.length).to.be.within(1, ids.length - 1);
      expect(hidden).not.to.include(ids[0]);
      expect(hidden, 'the tail of the strip').to.deep.equal(ids.slice(ids.length - hidden.length));
    });

    it('lists the active tab selected when it is scrolled out of view', async () => {
      const { el, strip, open, rows } = await render();
      strip.scrollLeft = strip.scrollWidth;
      await settle(el);
      await open();
      const selected = rows().filter((r) => r.hasAttribute('selected'));
      expect(selected.map((r) => r.getAttribute('value'))).to.deep.equal([ids[0]]);
      expect(rows()[0].getAttribute('value')).to.equal(ids[0]);
    });

    it('activates a picked row and closes the menu', async () => {
      const { el, open, rows, menu, listen } = await render();
      await open();
      const activations = listen('acp-tab-activate');
      const row = rows()[0];
      /** @type {HTMLElement} */ (row.shadowRoot?.querySelector('.md-menu-item__interactive')).click();
      await settle(el);
      expect(activations).to.deep.equal([{ id: row.getAttribute('value') }]);
      expect(menu().open).to.be.false;
    });

    it("closes a row's tab with its ×, keeping the menu open", async () => {
      const { el, open, listed, menu, listen, closeRow } = await render();
      await open();
      const closes = listen('acp-tab-close');
      const activations = listen('acp-tab-activate');
      const id = /** @type {string} */ (listed().at(-1));
      closeRow(id);
      await settle(el);
      expect(closes).to.deep.equal([{ id, scope: 'tab' }]);
      expect(activations).to.deep.equal([]);
      expect(menu().open).to.be.true;
    });

    it("unpins a pinned row's tab with its pin", async () => {
      const { el, strip, open, menu, listen, closeRow } = await render({ pinned: [ids[0]], active: ids[5] });
      strip.scrollLeft = strip.scrollWidth;
      await settle(el);
      await open();
      const pins = listen('acp-tab-pin');
      closeRow(ids[0]);
      await settle(el);
      expect(pins).to.deep.equal([{ id: ids[0], pinned: false }]);
      expect(menu().open).to.be.true;
    });

    it("asks before closing a row's tab with unsaved edits", async () => {
      const { el, root, open, listed, listen, closeRow } = await render({ dirty: [ids.at(-1) ?? ''] });
      await open();
      expect(listed()).to.include(ids.at(-1));
      const closes = listen('acp-tab-close');
      closeRow(/** @type {string} */ (ids.at(-1)));
      await settle(el);
      const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
      expect(dialog.options?.headline).to.equal('Discard unsaved changes?');
      expect(closes).to.deep.equal([]);
      dialog.close();
    });

    it('closes a row with Delete', async () => {
      const { el, open, rows, listen } = await render();
      await open();
      const closes = listen('acp-tab-close');
      const row = rows()[0];
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true }));
      await settle(el);
      expect(closes).to.deep.equal([{ id: row.getAttribute('value'), scope: 'tab' }]);
    });

    it('closes the menu with Escape', async () => {
      const { el, open, menu } = await render();
      await open();
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(el);
      expect(menu().open).to.be.false;
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
      return fixture(html`<acp-tab-view
        .tabs=${[fileTab(file)]}
        .active=${file}
        .root=${'/work/app'}
        .rootId=${'r1'}
        .listDir=${listDir}
        .worktrees=${/** @type {any} */ (props).worktrees ?? []}
        .languages=${/** @type {any} */ (props).languages ?? {}}
      ></acp-tab-view>`);
    };

    it('opens a language menu from the footer and picks a language for the file', async () => {
      const el = await render();
      await clickStatus(el, 'language');
      const menu = el.shadowRoot.querySelector('.acp-tab-view__language-menu');
      expect(menu.open).to.be.true;
      expect(menu.querySelector('md-menu-item[value="Python"]')).to.exist;
      const picks = listen(el, 'acp-tab-language');
      choose(el, 'acp-tab-view__language-menu', 'Python');
      expect(picks).to.deep.equal([{ path: file, language: 'Python' }]);
    });

    it('goes back to the detected language with Auto Detect', async () => {
      const el = await render({ languages: { [file]: 'Python' } });
      await clickStatus(el, 'language');
      const picks = listen(el, 'acp-tab-language');
      choose(el, 'acp-tab-view__language-menu', '');
      expect(picks).to.deep.equal([{ path: file, language: '' }]);
    });

    it("sets the editor's language to the file's pick", async () => {
      const el = await render({ languages: { [file]: 'Python' } });
      expect(el.shadowRoot.querySelector('cdx-code-editor').language).to.equal('Python');
    });

    it('opens a file menu from the file crumb', async () => {
      const el = await render();
      await clickStatus(el, 'file');
      expect(el.shadowRoot.querySelector('.acp-tab-view__file-menu').open).to.be.true;
      const reveals = listen(el, 'acp-file-reveal');
      const copies = listen(el, 'acp-copy-path');
      choose(el, 'acp-tab-view__file-menu', 'reveal');
      choose(el, 'acp-tab-view__file-menu', 'copy-path');
      choose(el, 'acp-tab-view__file-menu', 'copy-relative-path');
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
      const menu = el.shadowRoot.querySelector('.acp-tab-view__folder-menu');
      expect(menu.open).to.be.true;
      const items = [...menu.querySelectorAll('md-menu-item')];
      expect(items.map((i) => i.getAttribute('value'))).to.deep.equal(['node_modules', 'src', 'package.json']);
      expect(items.filter((i) => i.hasAttribute('selected')).map((i) => i.getAttribute('value'))).to.deep.equal(['src']);
    });

    it("selects the file itself in its own folder's list", async () => {
      const el = await render();
      await clickStatus(el, 'path', 2);
      expect(listed).to.deep.equal([['r1', 'src/lib']]);
      const selected = el.shadowRoot.querySelector('.acp-tab-view__folder-menu md-menu-item[selected]');
      expect(selected?.getAttribute('value')).to.equal('src/lib/main.js');
    });

    it('opens a file and reveals a folder picked in a crumb\'s list', async () => {
      const el = await render();
      await clickStatus(el, 'path', 0);
      const opens = listen(el, 'acp-file-open');
      const reveals = listen(el, 'acp-file-reveal');
      choose(el, 'acp-tab-view__folder-menu', 'package.json');
      choose(el, 'acp-tab-view__folder-menu', 'src');
      expect(opens).to.deep.equal([{ path: '/work/app/package.json' }]);
      expect(reveals).to.deep.equal([{ path: '/work/app/src', expand: true }]);
    });

    it("reveals a worktree session's file as the project's same file", async () => {
      const folder = '/data/worktrees/app-1/s1';
      const wtFile = `${folder}/src/main.js`;
      const el = await fixture(html`<acp-tab-view
        .tabs=${[fileTab(wtFile)]}
        .active=${wtFile}
        .root=${'/work/app'}
        .worktrees=${[{ sessionId: 's1', projectId: '/work/app', folder, branch: 'brama/x', title: 'X' }]}
      ></acp-tab-view>`);
      await clickStatus(el, 'path', 0);
      const reveals = listen(el, 'acp-file-reveal');
      choose(el, 'acp-tab-view__file-menu', 'reveal');
      expect(reveals).to.deep.equal([{ path: '/work/app/src', expand: true }]);
    });
  });
});
