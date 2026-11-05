import { expect, fixture, html } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import '../code-view.js';

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

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
    const mod = app.platform === 'mac' ? 'metaKey' : 'ctrlKey';

    /**
     * @param {Partial<EditorTab>} props
     * @param {KeyboardEventInit} [keys] The keys pressed: Mod+S unless given.
     */
    async function save(props, keys = { key: 's', code: 'KeyS', [mod]: true }) {
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
        ?.dispatchEvent(new KeyboardEvent('keydown', { ...keys, bubbles: true, composed: true }));
      return fired;
    }

    it('saves an editable file', async () => {
      expect(await save({})).to.deep.equal([{ type: 'acp-tab-save', detail: { id: path } }]);
    });

    it('saves on Mod+S by position on a non-Latin layout, not with Shift added', async () => {
      // Act + Assert
      expect(await save({}, { key: 'ы', code: 'KeyS', [mod]: true }), 'Cyrillic').to.have.length(1);
      expect(await save({}, { key: 'S', code: 'KeyS', [mod]: true, shiftKey: true }), 'Mod+Shift+S').to.deep.equal([]);
    });

    it('reports a conflict instead when the file changed on disk', async () => {
      expect(await save({ changedOnDisk: true })).to.deep.equal([{ type: 'acp-tab-conflict', detail: { id: path } }]);
    });
  });

  it('moves focus into the selection’s actions on Alt+F10, not on Ctrl+Alt+F10', async () => {
    // Arrange
    /** @type {EditorTab} */
    const tab = { ...fileTab('/p/a.js'), loaded: true, content: 'one two\n' };
    const el = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (await fixture(html`<acp-code-view .tab=${tab} .root=${'/p'}></acp-code-view>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const editor = /** @type {HTMLElementTagNameMap['cdx-code-editor']} */ (root.querySelector('cdx-code-editor'));
    await until(() => !!editor.view);
    editor.selection.set(0, 3);
    await until(() => !!root.querySelector('acp-selection-actions'));
    const actions = /** @type {HTMLElement} */ (root.querySelector('acp-selection-actions'));
    const press = (/** @type {KeyboardEventInit} */ init) =>
      editor.view?.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', code: 'F10', altKey: true, bubbles: true, composed: true, cancelable: true, ...init }),
      );

    // Act + Assert: an extra modifier
    press({ ctrlKey: true });
    expect(actions.matches(':focus-within'), 'Ctrl+Alt+F10').to.equal(false);

    // Act
    press({});
    // Assert
    expect(actions.matches(':focus-within'), 'Alt+F10').to.equal(true);
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
      return folders[rel] ?? [];
    };

    /** @param {object} [props] */
    const render = (props = {}) => {
      listed = [];
      return fixture(html`<acp-code-view
        .tab=${fileTab(file)}
        .root=${'/work/app'}
        .rootId=${'r1'}
        .listDir=${listDir}
        .workspaces=${/** @type {any} */ (props).workspaces ?? []}
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
        .workspaces=${[{ projectPath: '/work/app', folder, branch: 'brama/x' }]}
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

  describe('trying to edit a read-only file', () => {
    /** @param {string} [path] */
    async function render(path = '/p/a.js') {
      /** @type {EditorTab} */
      const tab = { ...fileTab(path), loaded: true, content: 'one\ntwo\nthree\n' };
      const el = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (await fixture(html`<acp-code-view .tab=${tab} .root=${'/p'}></acp-code-view>`));
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const editor = /** @type {HTMLElementTagNameMap['cdx-code-editor']} */ (root.querySelector('cdx-code-editor'));
      await until(() => !!editor.view);
      const view = /** @type {import('@codemirror/view').EditorView} */ (editor.view);
      const hint = () => /** @type {HTMLElementTagNameMap['md-rich-tooltip'] | null} */ (root.querySelector('md-rich-tooltip'));
      const isOpen = () => hint()?.matches(':popover-open') ?? false;
      return { el, root, editor, view, hint, isOpen };
    }
    /**
     * @param {HTMLElement} target
     * @param {string} type
     */
    const fire = (target, type) => target.dispatchEvent(new Event(type, { bubbles: true, composed: true, cancelable: true }));
    const settle = () => new Promise((r) => setTimeout(r, 50));

    it('says why, for what counts as an edit and nothing else', async () => {
      /** @type {[string, boolean, (view: import('@codemirror/view').EditorView, editor: HTMLElement) => void][]} */
      const cases = [
        ['beforeinput', true, (view) => fire(view.contentDOM, 'beforeinput')],
        ['paste', true, (view) => fire(view.contentDOM, 'paste')],
        ['cut', true, (view) => fire(view.contentDOM, 'cut')],
        ['drop', true, (view) => fire(view.contentDOM, 'drop')],
        ...['Backspace', 'Delete'].map((key) => /** @type {[string, boolean, (view: import('@codemirror/view').EditorView) => void]} */ ([
          key,
          true,
          (view) => {
            view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
          },
        ])),
        ['copy', false, (view) => fire(view.contentDOM, 'copy')],
        ['a key that only moves', false, (view) => {
          view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
        }],
        ['typing in a field inside the editor', false, (_view, editor) => {
          const field = editor.appendChild(document.createElement('textarea'));
          fire(field, 'beforeinput');
        }],
      ];
      for (const [name, shown, act] of cases) {
        // Arrange
        const { root, editor, view, hint, isOpen } = await render();
        // Act
        act(view, editor);
        await settle();
        // Assert
        expect(isOpen(), name).to.equal(shown);
        expect(view.state.doc.toString(), name).to.equal('one\ntwo\nthree\n');
        if (shown) {
          expect(hint()?.querySelector('[slot="subhead"]')?.textContent, name).to.equal('This file is read-only');
          expect(hint()?.textContent, name).to.contain('Ask the agent to make this change.');
          expect(root.querySelector('[role="status"]')?.textContent, name).to.contain('Ask the agent to make this change.');
        }
      }
    });

    it('says nothing in a file that can be edited', async () => {
      // Arrange
      const { view, isOpen } = await render('/p/.brama/agents.json');
      // Act
      fire(view.contentDOM, 'beforeinput');
      await settle();
      // Assert
      expect(isOpen()).to.equal(false);
    });

    it('moves to the caret on another try, one hint announced once', async () => {
      // Arrange
      const { root, editor, view, hint, isOpen } = await render();
      const status = /** @type {Element} */ (root.querySelector('[role="status"]'));
      fire(view.contentDOM, 'beforeinput');
      await settle();
      const firstTop = hint()?.getBoundingClientRect().top ?? 0;
      /** @type {MutationRecord[]} */
      const changes = [];
      const watcher = new MutationObserver((records) => changes.push(...records));
      watcher.observe(status, { childList: true, characterData: true, subtree: true });
      // Act: the caret moves, which closes it, then two tries, as key repeat would
      editor.navigation.goToLine(3);
      await settle();
      expect(isOpen(), 'closed by the caret').to.equal(false);
      fire(view.contentDOM, 'beforeinput');
      await settle();
      const secondTop = hint()?.getBoundingClientRect().top ?? 0;
      const announcements = changes.length;
      fire(view.contentDOM, 'beforeinput');
      await settle();
      watcher.disconnect();
      // Assert
      expect(isOpen()).to.equal(true);
      expect(root.querySelectorAll('md-rich-tooltip')).to.have.length(1);
      expect(secondTop, 'a line lower').to.be.greaterThan(firstTop);
      expect(changes.length, 'the repeat says nothing new').to.equal(announcements);
    });

    it('closes on Escape, on focus leaving the editor and by itself', async () => {
      /** @type {[string, (t: { view: import('@codemirror/view').EditorView, hint: () => HTMLElement | null, runTimer: () => void }) => void | Promise<void>, boolean][]} */
      const cases = [
        ['Escape', ({ view }) => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })); }, false],
        ['focus leaving', ({ view }) => {
          const other = document.body.appendChild(document.createElement('button'));
          view.contentDOM.focus();
          other.focus();
          other.remove();
        }, false],
        ['its time', ({ runTimer }) => runTimer(), false],
      ];
      for (const [name, act, open] of cases) {
        // Arrange
        const realSetTimeout = window.setTimeout;
        /** @type {(() => void) | undefined} */
        let closeTimer;
        window.setTimeout = /** @type {typeof setTimeout} */ ((/** @type {() => void} */ fn, /** @type {number} */ ms, /** @type {unknown[]} */ ...rest) => {
          if (ms === 6000) closeTimer = fn;
          return realSetTimeout(fn, ms === 6000 ? 1e7 : ms, ...rest);
        });
        const { view, hint, isOpen } = await render();
        fire(view.contentDOM, 'beforeinput');
        await settle();
        expect(isOpen(), `${name}: open first`).to.equal(true);
        // Act
        await act({ view, hint, runTimer: () => closeTimer?.() });
        await settle();
        window.setTimeout = realSetTimeout;
        // Assert
        expect(isOpen(), name).to.equal(open);
      }
    });
  });
});
