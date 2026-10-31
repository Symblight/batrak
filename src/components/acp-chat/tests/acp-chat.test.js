import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-chat.js';

/** @typedef {import('../acp-chat.js').AcpChat} AcpChat */
/**
 * The composer's document, as far as these tests read it.
 * @typedef {{ type: { name: string }, attrs: { label: string, data: Record<string, string> }, textContent: string }} DocNode
 * @typedef {{ descendants: (f: (node: DocNode) => void) => void, textContent: string }} Doc
 */

/** @param {AcpChat} chat */
function docOf(chat) {
  const composer = /** @type {import('lit').LitElement} */ (chat.renderRoot.querySelector('chx-message-composer'));
  const textbox = /** @type {HTMLElement & { editor: { view: { state: { doc: Doc } } } }} */ (
    composer.renderRoot.querySelector('chx-textbox')
  );
  return textbox.editor.view.state.doc;
}

/** @param {AcpChat} chat */
function chipsOf(chat) {
  /** @type {{ label: string, data: Record<string, string> }[]} */
  const chips = [];
  docOf(chat).descendants((node) => {
    if (node.type.name === 'chip') chips.push({ label: node.attrs.label, data: node.attrs.data });
  });
  return chips;
}

describe('acp-chat', () => {
  it('inserts dropped files and folders as chips, like ones picked with @', async () => {
    const chat = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    expect(await chat.composerReady()).to.equal(true);
    chat.insertFiles([
      { path: 'src/app.js', folder: false },
      { path: 'src', folder: true },
      { path: '/Users/me/notes.md', folder: false },
    ]);
    expect(chipsOf(chat)).to.deep.equal([
      { label: 'app.js', data: { path: 'src/app.js' } },
      { label: 'src', data: { path: 'src', kind: 'folder' } },
      { label: 'notes.md', data: { path: '/Users/me/notes.md' } },
    ]);
  });

  it('inserts nothing for no files', async () => {
    const chat = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    await chat.composerReady();
    chat.insertFiles([]);
    expect(chipsOf(chat)).to.deep.equal([]);
  });
});
