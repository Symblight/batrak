import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $markdownModes } from '../../../stores/markdown-view/markdown-view.js';
import { $markdownSplit } from '../../../stores/layout/layout.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $fileLanguages, setFileLanguage } from '../../../stores/editor/editor.js';
import { $commentFocus, $comments } from '../../../stores/comments/comments.js';
import { $settings } from '../../../stores/settings/settings.js';
import { $rootId, $workspace } from '../../../stores/workspace/workspace.js';
import '../editor-view.js';

/** @typedef {import('../editor-view.js').AcpEditorView} AcpEditorView */
/** @typedef {import('../../../hooks/tabs/types.js').EditorTab} EditorTab */

/** @type {EditorTab} */
const tab = {
  id: '/p/a.js',
  kind: 'file',
  path: '/p/a.js',
  content: 'let a;',
  error: '',
  loaded: true,
  image: null,
  baseline: null,
  draft: null,
  changedOnDisk: false,
  deletedOnDisk: false,
};

describe('acp-editor-view', () => {
  const settings = $settings.get();

  beforeEach(() => {
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $fileLanguages.set({});
    $comments.set({});
    $commentFocus.set(null);
    $settings.set(settings);
    $workspace.set(null);
  });

  /** @returns {Promise<{ el: AcpEditorView, code: HTMLElementTagNameMap['acp-code-view'] }>} */
  async function render() {
    const el = /** @type {AcpEditorView} */ (await fixture(html`<acp-editor-view .tab=${tab}></acp-editor-view>`));
    const code = /** @type {HTMLElementTagNameMap['acp-code-view']} */ (el.querySelector('acp-code-view'));
    return { el, code };
  }

  it("gives the file's editor what it needs: the project, the file's language and the file's comments", async () => {
    // Arrange
    setFileLanguage('/p/a.js', 'python');
    $comments.set({ '/p/a.js': [{ id: 't1', line: 1, comments: [] }] });
    $commentFocus.set({ path: '/p/a.js', threadId: 't1' });

    // Act
    const { code } = await render();

    // Assert
    expect(code.tab).to.equal(tab);
    expect(code.root, 'project').to.equal('/p');
    expect(code.rootId, 'its snapshot').to.equal($rootId.get());
    expect(code.language, 'picked').to.equal('python');
    expect(Object.keys(code.comments), 'comments').to.deep.equal(['/p/a.js']);
    expect(code.commentFocus).to.deep.equal({ path: '/p/a.js', threadId: 't1' });
  });

  it('follows the stores: a language picked in the footer is kept, and shows at once', async () => {
    // Arrange
    const { el, code } = await render();
    expect(code.language, 'by extension').to.equal('');

    // Act
    code.dispatchEvent(new CustomEvent('acp-tab-language', { detail: { path: '/p/a.js', language: 'ruby' }, bubbles: true, composed: true }));
    await el.updateComplete;

    // Assert
    expect($fileLanguages.get()).to.deep.equal({ '/p/a.js': 'ruby' });
    expect(code.language).to.equal('ruby');
  });

  describe('a markdown file', () => {
    /** @type {EditorTab} */
    const md = { ...tab, id: '/p/docs/a.md', path: '/p/docs/a.md', content: '# Title' };

    afterEach(() => {
      clearMocks();
      $markdownModes.setKey('/p', undefined);
      $markdownSplit.set(50);
      $notices.set([]);
    });

    /** @returns {Promise<{ el: AcpEditorView, view: HTMLElementTagNameMap['acp-markdown-view'] }>} */
    async function renderMarkdown() {
      const el = /** @type {AcpEditorView} */ (await fixture(html`<acp-editor-view .tab=${md}></acp-editor-view>`));
      const view = /** @type {HTMLElementTagNameMap['acp-markdown-view']} */ (el.querySelector('acp-markdown-view'));
      return { el, view };
    }

    /**
     * @param {Element} from
     * @param {string} type
     * @param {object} detail
     */
    const fire = (from, type, detail) => from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

    it('is shown in the markdown view, with the project and the view it was left in', async () => {
      $settings.set({ ...settings, markdownDefaultView: 'split', markdownScrollSync: false });
      $markdownSplit.set(35);

      const { view } = await renderMarkdown();

      expect(view.tab).to.equal(md);
      expect([view.mode, view.scrollSync, view.ratio]).to.deep.equal(['split', false, 35]);
      expect(view.root).to.equal('/p');
      expect(typeof view.loadImage).to.equal('function');
    });

    it('leaves other files with the plain editor', async () => {
      const { el } = await render();

      expect(el.querySelector('acp-markdown-view')).to.equal(null);
    });

    it('remembers the view that is picked, for this file only', async () => {
      const { el, view } = await renderMarkdown();

      fire(view, 'acp-markdown-mode', { id: md.id, mode: 'preview' });
      await el.updateComplete;

      expect(view.mode).to.equal('preview');
      expect($markdownModes.get()['/p']).to.deep.equal({ 'docs/a.md': 'preview' });
    });

    it('keeps the scroll sync and the divider for every markdown file', async () => {
      const { view } = await renderMarkdown();

      fire(view, 'acp-markdown-sync', { on: false });
      fire(view, 'acp-markdown-ratio', { ratio: 62 });

      expect($settings.get().markdownScrollSync).to.equal(false);
      expect($markdownSplit.get()).to.equal(62);
    });

    it('reads a local image through the backend, typed by its extension', async () => {
      mockIPC((cmd, args) => (cmd === 'read_file_bytes' ? new Uint8Array([137, 80, 78, 71]).buffer : Promise.reject(new Error(`${cmd} ${JSON.stringify(args)}`))));
      const { view } = await renderMarkdown();

      const blob = await /** @type {(path: string) => Promise<Blob>} */ (view.loadImage)('/p/docs/pic.svg');

      expect(blob.type).to.equal('image/svg+xml');
      expect(blob.size).to.equal(4);
    });

    describe('a link of the preview', () => {
      /** @param {string} cmd @param {any} args */
      const listing = (cmd, args) => {
        if (cmd !== 'list_dir') return Promise.reject(new Error(cmd));
        return args.path === 'docs'
          ? [
              { name: 'other.md', path: 'docs/other.md', isDir: false },
              { name: 'sub', path: 'docs/sub', isDir: true },
            ]
          : [];
      };

      /**
       * A link as the preview fires it.
       * @param {Element} view
       * @param {string} type
       * @param {string} path
       */
      function link(view, type, path) {
        const markdown = document.createElement('acp-markdown');
        view.append(markdown);
        fire(markdown, type, { path, expand: true });
        markdown.remove();
      }

      it('opens a file that is there, as it would from anywhere', async () => {
        mockIPC(listing);
        const { el, view } = await renderMarkdown();
        $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
        /** @type {unknown[]} */
        const heard = [];
        el.addEventListener('acp-file-open', (e) => heard.push(/** @type {CustomEvent} */ (e).detail));

        link(view, 'acp-file-open', '/p/docs/other.md');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(heard).to.deep.equal([{ path: '/p/docs/other.md', expand: true }]);
        expect($notices.get()).to.deep.equal([]);
      });

      it('says so, and opens nothing, when the file or folder is not there', async () => {
        mockIPC(listing);
        const { el, view } = await renderMarkdown();
        $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
        /** @type {unknown[]} */
        const heard = [];
        el.addEventListener('acp-file-open', (e) => heard.push(e));
        el.addEventListener('acp-file-reveal', (e) => heard.push(e));

        link(view, 'acp-file-open', '/p/docs/missing.md');
        link(view, 'acp-file-reveal', '/p/docs/nowhere');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(heard).to.deep.equal([]);
        expect($notices.get().map((n) => [n.level, n.message])).to.deep.equal([
          ['warn', 'Not found: docs/missing.md'],
          ['warn', 'Not found: docs/nowhere'],
        ]);
      });

      it('leaves a link of the editor’s footer alone', async () => {
        mockIPC(listing);
        const { el, view } = await renderMarkdown();
        /** @type {unknown[]} */
        const heard = [];
        el.addEventListener('acp-file-open', (e) => heard.push(e));

        fire(view, 'acp-file-open', { path: '/p/docs/missing.md' });

        expect(heard).to.have.length(1);
      });
    });
  });
});
