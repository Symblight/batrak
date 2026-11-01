import { expect, fixture, html } from '../../../../test/fixture.js';
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

  it("gives the file's editor what it needs: the project, the file's language, the editor font, and the file's comments", async () => {
    // Arrange
    setFileLanguage('/p/a.js', 'python');
    $settings.set({ ...settings, editorFont: 'Fira Code', editorFontSize: 15 });
    $comments.set({ '/p/a.js': [{ id: 't1', line: 1, comments: [] }] });
    $commentFocus.set({ path: '/p/a.js', threadId: 't1' });

    // Act
    const { code } = await render();

    // Assert
    expect(code.tab).to.equal(tab);
    expect(code.root, 'project').to.equal('/p');
    expect(code.rootId, 'its snapshot').to.equal($rootId.get());
    expect(code.language, 'picked').to.equal('python');
    expect([code.editorFont, code.editorFontSize], 'font').to.deep.equal(['Fira Code', 15]);
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
});
