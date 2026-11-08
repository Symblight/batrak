import { expect, fixture, html } from '../../../../test/fixture.js';
import '../chat.js';
import { sessions } from '../../../hooks/sessions/sessions.js';
import { agentsMd } from '../../../hooks/agents-md/agents-md.js';
import { LitElement } from 'lit';
import { MessageBuilder } from '../../../hooks/sessions/message-builder.js';
import { ChatPartsController } from '../../../controllers/chat-parts/ChatPartsController.js';

/** @typedef {import('../../../hooks/sessions/types.js').AcpSessionUpdate} AcpSessionUpdate */

/** A short chat (320px with its composer) that draws parts as the chat column does, and hands out its reply stream. */
class PartsHost extends LitElement {
  parts = new ChatPartsController(this, { attachments: () => /** @type {never} */ (null) });
  /** @type {(controller: ReadableStreamDefaultController<unknown>) => void} */
  #opened = () => {};
  /** @type {Promise<ReadableStreamDefaultController<unknown>>} The reply's stream, once a message is sent. */
  stream = new Promise((resolve) => (this.#opened = resolve));
  #adapter = {
    sendMessage: async () => new ReadableStream({ start: (controller) => this.#opened(controller) }),
  };

  createRenderRoot() {
    return this;
  }

  render() {
    return html`<div style="display: flex; width: 640px; height: 320px">
      <acp-chat .userId=${'me'} .conversationId=${'s1'} .adapter=${this.#adapter} .partElements=${this.parts.partElements}></acp-chat>
    </div>`;
  }
}
customElements.define('test-chat-parts-host', PartsHost);

/** @param {string} text @returns {AcpSessionUpdate[]} The text as an agent streams it, a few words a chunk. */
function said(text) {
  return (text.match(/(?:\S+\s*){1,4}/g) ?? []).map((words) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: words },
  }));
}

/** @returns {AcpSessionUpdate[]} The start of an agent's reply to the AGENTS.md prompt: text, commands, a failed one. */
function replyUpdates() {
  const command = (/** @type {string} */ id, /** @type {string} */ title) => /** @type {AcpSessionUpdate[]} */ ([
    { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' },
  ]);
  return [
    ...said("I'll start by reading the existing instruction files, manifests, and CI to see what AGENTS.md needs to cover."),
    ...command('t1', "git status --short && echo ---- && find . -path ./node_modules -prune -o -name '*.md' -print"),
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    ...command('t2', 'cat AGENTS.md; echo ======CLAUDE.md; cat CLAUDE.md; echo ======apps/desktop/CLAUDE.md'),
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '```\nExit code 1 cat: AGENTS.md: No such file or directory\n======CLAUDE.md not found\n```' } }],
    },
    ...said(
      'The root has a `CLAUDE.md` that imports `AGENTS.md`, but no `AGENTS.md` exists yet, so this is a new file. ' +
        'Before writing it I need the commands and the rules the project already states:\n\n' +
        '1. The manifests: `Cargo.toml`, `apps/desktop/package.json` and the workspace members.\n' +
        '2. CI under `.github/workflows/`, for the exact checks.\n' +
        '3. The nested `apps/desktop/CLAUDE.md`, which gets an `AGENTS.md` of its own.\n\n' +
        '```bash\ncargo test --workspace\ncargo clippy --all-targets\ncd apps/desktop && pnpm typecheck && pnpm test\n```\n\n' +
        'Next I read the CI workflow and the package manifests.',
    ),
    ...command('t3', 'cat .github/workflows/ci.yml apps/desktop/package.json'),
    { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' },
    ...said('CI runs the backend on macOS, the CLI also on Windows, and the frontend on Ubuntu; that goes under Gotchas.'),
  ];
}

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
  it('Up brings a replayed prompt back with its chips and paste', async () => {
    // Arrange
    const el = /** @type {AcpChat} */ (await fixture(html`<acp-chat .root=${'/p'}></acp-chat>`));
    await el.composerReady();
    el.chat?.store.add({
      id: 'm',
      own: true,
      parts: [{ id: 'p', type: 'text', text: '/review @src/a.js and @src/\n```js\nx\n```' }],
    });
    const composer = /** @type {import('lit').LitElement} */ (el.renderRoot.querySelector('chx-message-composer'));
    const textbox = /** @type {HTMLElement & { editor: { view: { dom: HTMLElement } } }} */ (
      composer.renderRoot.querySelector('chx-textbox')
    );

    // Act
    textbox.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));

    // Assert
    expect(chipsOf(el).map((chip) => chip.label)).to.deep.equal(['/review', 'a.js', 'src']);
    /** @type {string[]} */
    const pastes = [];
    docOf(el).descendants((node) => {
      if (node.type.name === 'paste') pastes.push(node.type.name);
    });
    expect(pastes).to.have.length(1);
  });

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

  it('stays at the bottom while a reply streams in after a send, in a short chat', async function () {
    this.timeout(20000);
    // Arrange: a short chat rendering parts as the app does, its agent replying as ACP updates
    const host = /** @type {PartsHost} */ (await fixture(html`<test-chat-parts-host></test-chat-parts-host>`));
    const el = /** @type {AcpChat} */ (host.querySelector('acp-chat'));
    await el.composerReady();
    const list = /** @type {import('lit').LitElement} */ (el.renderRoot.querySelector('chx-message-list'));
    const infinity = /** @type {import('lit').LitElement} */ (list.renderRoot.querySelector('chx-infinity-scroll'));
    const scroller = /** @type {HTMLElement} */ (infinity.renderRoot.querySelector('.infinity-scroll__scroller'));
    const builder = new MessageBuilder('s1', 'agent', { live: true });
    /** @type {string[]} Where the view wasn't at the bottom, by the step just streamed. */
    const away = [];

    // Act: the AGENTS.md prompt is sent, then the reply streams
    el.chat?.dispatchEvent(
      new CustomEvent('chx-send-message', {
        detail: { value: agentsMd.PROMPT, html: agentsMd.PROMPT, attachments: [], commands: [] },
        bubbles: true,
        composed: true,
      }),
    );
    const stream = await host.stream;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const updates = replyUpdates();
    for (const [step, update] of updates.entries()) {
      for (const chunk of builder.chunks(update)) stream.enqueue(chunk);
      if (step % 3 === 2) await frame();
      // text, then a pause while the agent works: the reply so far must be in view meanwhile
      const next = updates[step + 1];
      if (update.sessionUpdate !== 'agent_message_chunk' || (next && next.sessionUpdate === 'agent_message_chunk')) continue;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const distance = Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
      if (distance > 8) away.push(`step ${step}: ${distance}px below`);
    }
    for (const chunk of builder.finish()) stream.enqueue(chunk);
    stream.close();

    // Assert
    expect(away).to.deep.equal([]);
  });

  it('asks for the next task above the composer until the first message', async () => {
    // Arrange + Act
    const draft = /** @type {AcpChat} */ (await fixture(html`<acp-chat empty></acp-chat>`));
    const started = /** @type {AcpChat} */ (await fixture(html`<acp-chat></acp-chat>`));

    // Assert
    expect(draft.renderRoot.querySelector('h2')?.textContent).to.equal("What's the next task?");
    expect(started.renderRoot.querySelector('h2'), 'none once started').to.equal(null);
  });

  it('offers to review uncommitted files only on a draft that can send and has some', async () => {
    const cases = [
      { props: { empty: true, uncommitted: 3 }, label: 'Review 3 uncommitted files' },
      { props: { empty: true, uncommitted: 0 }, label: null },
      { props: { empty: false, uncommitted: 3 }, label: null },
      { props: { empty: true, uncommitted: 3, blocked: { message: 'Gone', workspaceId: 'w1' } }, label: null },
    ];
    for (const { props, label } of cases) {
      // Arrange
      const el = /** @type {AcpChat} */ (await fixture(html`<acp-chat></acp-chat>`));

      // Act
      Object.assign(el, props);
      await el.updateComplete;

      // Assert
      const list = /** @type {HTMLElement | null} */ (el.renderRoot.querySelector('chx-suggestion-list'));
      expect(list?.querySelector('chx-suggestion')?.textContent?.trim() ?? null, JSON.stringify(props)).to.equal(label);
      if (list) expect([list.slot, list.hidden], 'above the field, visible').to.deep.equal(['suggestions', false]);
    }
  });

  it('a click on the hint fills the composer without sending, keeping a draft already typed', async () => {
    const cases = [
      { typed: '', lines: ['Review the 3 uncommitted files'] },
      { typed: 'Look at login first', lines: ['Look at login first', 'Review the 3 uncommitted files'] },
    ];
    for (const { typed, lines } of cases) {
      // Arrange
      const el = /** @type {AcpChat} */ (await fixture(html`<acp-chat empty .uncommitted=${3}></acp-chat>`));
      await el.composerReady();
      const composer = /** @type {import('lit').LitElement} */ (el.renderRoot.querySelector('chx-message-composer'));
      if (typed) /** @type {HTMLElement & { setText: (text: string) => void }} */ (composer.renderRoot.querySelector('chx-textbox')).setText(typed);
      /** @type {string[]} */
      const fired = [];
      el.addEventListener('acp-chat-hint-use', (e) => fired.push(e.type));
      el.addEventListener('chx-send-message', (e) => fired.push(e.type));

      // Act
      /** @type {HTMLElement} */ (el.renderRoot.querySelector('chx-suggestion')).click();
      await el.updateComplete;

      // Assert
      /** @type {string[]} */
      const shown = [];
      docOf(el).descendants((node) => {
        if (node.type.name === 'line') shown.push(node.textContent);
      });
      expect(shown).to.deep.equal(lines);
      expect(fired).to.deep.equal(['acp-chat-hint-use']);
    }
  });

  /** @param {AcpChat} chat Its banner's button, once rendered: there only while the offer shows. */
  async function createAgentsMdButton(chat) {
    const banner = /** @type {import('lit').LitElement} */ (chat.renderRoot.querySelector('acp-session-banner'));
    await banner.updateComplete;
    return /** @type {HTMLElement | null} */ (banner.renderRoot.querySelector('md-button'));
  }

  it('offers to create AGENTS.md only on a draft that can send', async () => {
    const cases = [
      { props: { empty: true, agentsMdOffer: true }, shown: true },
      { props: { empty: true, agentsMdOffer: false }, shown: false },
      { props: { empty: false, agentsMdOffer: true }, shown: false },
      { props: { empty: true, agentsMdOffer: true, blocked: { message: 'Gone', workspaceId: 'w1' } }, shown: false },
    ];
    for (const { props, shown } of cases) {
      // Arrange
      const el = /** @type {AcpChat} */ (await fixture(html`<acp-chat></acp-chat>`));

      // Act
      Object.assign(el, props);
      await el.updateComplete;

      // Assert
      expect((await createAgentsMdButton(el)) !== null, JSON.stringify(props)).to.equal(shown);
    }
  });

  it('Create AGENTS.md fills the composer with the whole prompt without sending, keeping a draft already typed', async () => {
    const prompt = agentsMd.PROMPT.split('\n');
    const cases = [
      { typed: '', lines: prompt },
      { typed: 'Look at login first', lines: ['Look at login first', ...prompt] },
    ];
    for (const { typed, lines } of cases) {
      // Arrange
      const el = /** @type {AcpChat} */ (await fixture(html`<acp-chat empty .agentsMdOffer=${true}></acp-chat>`));
      await el.composerReady();
      if (typed) el.chat?.input.setText(typed);
      /** @type {string[]} */
      const fired = [];
      el.addEventListener('chx-send-message', (e) => fired.push(e.type), { capture: true });

      // Act
      (await createAgentsMdButton(el))?.click();
      await el.updateComplete;

      // Assert
      /** @type {string[]} */
      const shown = [];
      docOf(el).descendants((node) => {
        if (node.type.name === 'line') shown.push(node.textContent);
      });
      expect(shown, `typed: ${typed}`).to.deep.equal(lines);
      expect(fired, 'nothing sent').to.deep.equal([]);
    }
  });

  it("hands a draft's footer where it runs, beside the full-access note; a started session has none", async () => {
    // Arrange
    const load = async () => {};
    const place = { target: { kind: 'worktree', base: null }, workspaceName: 'Fix login', branches: { local: ['main'], remotes: [], default: null }, base: 'main', load };
    const footerOf = (/** @type {AcpChat} */ el) => /** @type {HTMLElementTagNameMap['acp-run-target'] | null} */ (el.renderRoot.querySelector('acp-run-target'));

    // Act
    const draft = /** @type {AcpChat} */ (await fixture(html`<acp-chat empty .place=${place}></acp-chat>`));
    const started = /** @type {AcpChat} */ (await fixture(html`<acp-chat .place=${place}></acp-chat>`));

    // Assert
    const footer = footerOf(draft);
    expect([footer?.slot, footer?.target, footer?.workspaceName, footer?.branches, footer?.base, footer?.loadBranches]).to.deep.equal([
      'footer', place.target, 'Fix login', place.branches, 'main', load,
    ]);
    expect(footerOf(started), 'none once started').to.equal(null);
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
