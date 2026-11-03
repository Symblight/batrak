import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $project } from '../../../stores/project/project.js';
import { MAIN, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import '../chat-view.js';

/** @typedef {import('../chat-view.js').AcpChatView} AcpChatView */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('acp-chat-view', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      return answer(cmd);
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
  });

  afterEach(() => {
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    setActiveWorkspace('/p', MAIN);
    setWorkspaces([]);
    $project.set(null);
    clearMocks();
  });

  async function render() {
    const wrapper = await fixture(html`<div><acp-chat-view></acp-chat-view></div>`);
    const el = /** @type {AcpChatView} */ (wrapper.firstElementChild);
    await el.updateComplete;
    return el;
  }

  /**
   * @param {AcpChatView} el
   * @param {string} type
   * @param {object} detail
   */
  function fire(el, type, detail) {
    el.chat?.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('shows the chat of an opened project: hidden when concealed, marked while files are dragged over it, none without a project', async () => {
    // Arrange
    const el = await render();
    const chat = () => /** @type {HTMLElementTagNameMap['acp-chat']} */ (el.querySelector('acp-chat'));
    expect(chat().hidden, 'shown').to.equal(false);
    expect(chat().root).to.equal('/p');

    // Act
    el.concealed = true;
    el.dropping = true;
    await el.updateComplete;

    // Assert
    expect(chat().hidden, 'concealed').to.equal(true);
    expect(chat().hasAttribute('dropping'), 'dragged over').to.equal(true);
    expect(el.chat, 'the chat the column reaches').to.equal(chat());

    // Act
    $project.set(null);
    await el.updateComplete;

    // Assert
    expect(el.querySelector('acp-chat'), 'no project').to.equal(null);
  });

  it("sends the chat's intents to the backend: a permission answer, a link", async () => {
    // Arrange
    const el = await render();
    const intents = [
      ['acp-permission-respond', { requestId: 'r1', optionId: 'allow' }, 'session_respond_permission', { sessionId: 'd1', requestId: 'r1', optionId: 'allow' }],
      ['acp-link-open', { url: 'https://example.com' }, 'open_url', { url: 'https://example.com' }],
    ];

    for (const [type, detail, command, args] of intents) {
      // Act
      calls = [];
      fire(el, /** @type {string} */ (type), /** @type {object} */ (detail));
      await until(() => calls.some((c) => c.cmd === command));

      // Assert
      expect(calls.find((c) => c.cmd === command)?.args, String(type)).to.deep.equal(args);
    }
  });

  it('answers an @ query with the project files; a closed menu starts no search', async () => {
    // Arrange
    const el = await render();
    answer = (cmd) => (cmd === 'quick_open' ? { items: [{ path: 'src/a.js', kind: 'file' }], cancelled: false } : null);

    // Act
    fire(el, 'acp-chat-file-query', { query: 'a' });
    await until(() => el.fileOptions.length > 0);

    // Assert
    expect(calls.find((c) => c.cmd === 'quick_open')?.args).to.deep.equal({ rootId: 'r', query: 'a', kind: 'all' });
    expect(el.chat?.fileOptions).to.deep.equal([{ path: 'src/a.js', kind: 'file' }]);

    // Act: a closed menu (null) starts no search
    calls = [];
    fire(el, 'acp-chat-file-query', { query: null });
    await el.updateComplete;

    // Assert
    expect(calls.filter((c) => c.cmd === 'quick_open')).to.deep.equal([]);
  });

  it("blocks the composer while the shown workspace's folder is missing, and recreates it when asked", async () => {
    // Arrange
    /** @type {import('../../../hooks/workspaces/types.js').Workspace} */
    const workspace = {
      id: 'w1', projectPath: '/p', name: 'W', nameSource: 'user', folder: '/wt/w1', worktreePath: '/wt/w1', branch: 'brama/w',
      baseCommit: 'c0', baseBranch: null, createdAt: '2026-01-01T00:00:00Z', lastActiveAt: null, creating: false, error: null, missing: true,
    };
    setWorkspaces([workspace], '/p');
    setActiveWorkspace('/p', 'w1');
    const el = await render();

    // Assert
    expect(el.chat?.blocked).to.deep.equal({ message: 'Recreate the folder to continue', workspaceId: 'w1' });

    // Act
    fire(el, 'acp-workspace-recreate', { id: 'w1' });
    await until(() => calls.some((c) => c.cmd === 'workspace_recreate'));

    // Assert
    expect(calls.find((c) => c.cmd === 'workspace_recreate')?.args).to.deep.equal({ id: 'w1' });

    // Act: the folder is back
    setWorkspaces([{ ...workspace, missing: false }], '/p');
    await el.updateComplete;

    // Assert
    expect(el.chat?.blocked).to.equal(null);
  });
});
