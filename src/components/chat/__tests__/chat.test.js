import { expect, fixture, html } from '../../../../test/fixture.js';
import '../chat.js';
import { sessions } from '../../../hooks/sessions/sessions.js';

/** @typedef {import('../chat.js').AcpChat} AcpChat */
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

  it("sends its chips' paths in its html, which a session's input reads back", async () => {
    const chat = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    await chat.composerReady();
    chat.insertFiles([
      { path: 'src/stores/editor.js', folder: false },
      { path: 'src', folder: true },
    ]);
    const { html: sent } = /** @type {import('@symblight/chat').ChxChat} */ (chat.chat).input.getValue();
    const refs = sessions.inputOfComposer('m', sent, []).parts.filter((p) => p.kind === 'ref');
    expect(refs).to.deep.equal([
      { kind: 'ref', path: 'src/stores/editor.js', folder: false },
      { kind: 'ref', path: 'src', folder: true },
    ]);
  });

  it('hands attached files to its column, which saves them for path chips, and keeps none as attachments', async () => {
    const chat = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    await chat.composerReady();
    /** @type {File[][]} */
    const handed = [];
    chat.addEventListener('acp-chat-attach', (e) => handed.push(/** @type {CustomEvent<{ files: File[] }>} */ (e).detail.files));
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    chat.attachments.addFiles([shot], 'paste');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handed.map((files) => files.map((f) => f.name))).to.deep.equal([['shot.png']]);
    expect(chat.attachments.getAttachments()).to.deep.equal([]);
  });

  it('inserts nothing for no files', async () => {
    const chat = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    await chat.composerReady();
    chat.insertFiles([]);
    expect(chipsOf(chat)).to.deep.equal([]);
  });

  it("notes network and files outside the workspace for a draft's full-access mode, by its risk, not its name", async () => {
    // Arrange
    /** @param {import('../../../hooks/composer/types.js').ConfigOptionValue[]} options @param {string} current */
    const withMode = (options, current) => ({
      agentId: 'a',
      chosen: {},
      started: false,
      configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: /** @type {const} */ ('select'), currentValue: current, options }],
    });
    const note = (/** @type {AcpChat} */ el) => el.renderRoot.querySelector('.acp-chat__note');

    // Act
    const bypass = /** @type {AcpChat} */ (
      await fixture(html`<acp-chat empty .composer=${withMode([{ value: 'bypassPermissions', name: 'Bypass', risk: 'full' }], 'bypassPermissions')}></acp-chat>`)
    );
    const untagged = /** @type {AcpChat} */ (
      await fixture(html`<acp-chat empty .composer=${withMode([{ value: 'full', name: 'Full' }], 'full')}></acp-chat>`)
    );

    // Assert
    expect(note(bypass)?.textContent).to.contain('Network and files outside the workspace');
    expect(note(untagged)?.textContent ?? null, 'a name alone says nothing').to.equal(null);
  });

  it("disables the composer while blocked, says why and offers to recreate the workspace's folder", async () => {
    // Arrange
    const chat = /** @type {AcpChat} */ (
      await fixture(html`<acp-chat .blocked=${{ message: 'Recreate the folder to continue', workspaceId: 'w1' }}></acp-chat>`)
    );
    /** @type {unknown[]} */
    const fired = [];
    document.addEventListener('acp-workspace-recreate', (e) => fired.push(/** @type {CustomEvent} */ (e).detail), { once: true });
    const composer = /** @type {HTMLElement & { disabled: boolean }} */ (chat.renderRoot.querySelector('chx-message-composer'));

    // Act
    const button = /** @type {HTMLElement} */ (chat.renderRoot.querySelector('.acp-chat__blocked-action'));
    button.click();

    // Assert
    expect(composer.disabled, 'no sending').to.equal(true);
    expect(chat.renderRoot.querySelector('.acp-chat__blocked')?.textContent).to.contain('Recreate the folder to continue');
    expect(button.textContent?.trim()).to.equal('Recreate folder');
    expect(fired, 'reaches the document').to.deep.equal([{ id: 'w1' }]);

    // Act: the folder is back
    chat.blocked = null;
    await chat.updateComplete;

    // Assert
    expect(composer.disabled, 'sends again').to.equal(false);
    expect(chat.renderRoot.querySelector('.acp-chat__blocked')?.textContent ?? null).to.equal(null);
  });
});
