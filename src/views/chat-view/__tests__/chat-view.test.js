import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $project } from '../../../stores/project/project.js';
import { MAIN, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import { $composer, forgetComposer, setRunTarget } from '../../../stores/composer/composer.js';
import { $gitRepo, NO_REPO } from '../../../stores/git/git.js';
import '../chat-view.js';

/** A repository with a commit: the project can have workspaces. */
const REPO = { repo: /** @type {import('../../../hooks/git/types.js').GitRepoState} */ ({ sha: 'abc' }), error: null };

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
    $gitRepo.set(REPO);
  });

  afterEach(() => {
    $gitRepo.set(NO_REPO);
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

  it("gives a draft's footer its place, keeps a pick in the draft, and bases New worktree on Main's branches, listed at each opening of its base menu and fetched before the first per draft", async () => {
    // Arrange: a draft of a worktree workspace, shown
    answer = (cmd) => {
      if (cmd === 'git_branches') return { local: ['main', 'dev'], remotes: [], default: null };
      if (cmd === 'git_head') return { branch: 'main', detached: false };
      return null;
    };
    setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Fix login', folder: '/wt/w1', creating: false, missing: false, error: null })], '/p');
    setActiveWorkspace('/p', 'w1');
    $draftSessions.set({ d2: { projectId: '/p', workspaceId: 'w1' } });
    $activeSessionId.set('d2');
    const el = await render();
    const before = [el.chat?.place?.target, el.chat?.place?.workspaceName];
    const git = () => calls.filter((c) => c.cmd === 'git_branches' || c.cmd === 'git_fetch').map((c) => [c.cmd, c.args.rootId]);

    // Act: New worktree picked, then its base menu opened twice
    fire(el, 'acp-run-target-change', { target: { kind: 'worktree', base: null } });
    await until(() => el.chat?.place?.base === 'main');
    const listed = git();
    await el.chat?.place?.load();
    const second = el.chat?.place?.load();
    await el.updateComplete;
    const meanwhile = el.chat?.place?.base;
    await second;
    await el.updateComplete;

    // Assert
    expect(before, 'This workspace, by name').to.deep.equal([{ kind: 'workspace' }, 'Fix login']);
    expect($composer.get().runTarget, 'kept in the draft').to.deep.equal({ kind: 'worktree', base: null });
    expect(el.chat?.place?.branches.local).to.deep.equal(['main', 'dev']);
    expect(listed, "Main's root, listed as New worktree shows").to.deep.equal([['git_branches', 'r']]);
    expect(git(), 'fetched once, listed again at each opening').to.deep.equal([
      ['git_branches', 'r'],
      ['git_fetch', 'r'],
      ['git_branches', 'r'],
      ['git_branches', 'r'],
    ]);
    expect(meanwhile, 'its base kept while listed again').to.equal('main');
    forgetComposer('d2');
  });

  it('drops an answer for the branches of a project no longer shown', async () => {
    // Arrange: the branches of `r` answer late
    /** @type {(list: unknown) => void} */
    let late = () => {};
    answer = (cmd) => (cmd === 'git_branches' ? new Promise((resolve) => (late = resolve)) : null);
    $draftSessions.set({ d3: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d3');
    setRunTarget('d3', { kind: 'worktree', base: null });
    const el = await render();
    await until(() => calls.some((c) => c.cmd === 'git_branches'));

    // Act
    $project.set({ path: '/q', name: 'q', rootId: 'r-q' });
    late({ local: ['old'], remotes: [], default: null });
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // Assert
    expect(el.chat?.place?.branches.local ?? []).to.deep.equal([]);
    forgetComposer('d3');
  });

  it('offers New worktree only where the project can have workspaces, and shows a draft set to it as Local where it cannot', async () => {
    /** @type {[import('../../../hooks/git/types.js').GitRepoView, boolean, string, string][]} */
    const cases = [
      // [Main's repository, offered, the place shown, why]
      [REPO, true, 'worktree', 'a commit'],
      [{ repo: /** @type {import('../../../hooks/git/types.js').GitRepoState} */ ({ sha: null }), error: null }, false, 'local', 'no commit yet'],
      [NO_REPO, false, 'local', 'no repository'],
    ];
    for (const [repo, offered, shown, why] of cases) {
      // Arrange
      $gitRepo.set(repo);
      setRunTarget('d1', { kind: 'worktree', base: null });

      // Act
      const el = await render();

      // Assert
      expect([el.chat?.place?.worktrees, el.chat?.place?.target.kind], why).to.deep.equal([offered, shown]);
      forgetComposer('d1');
    }
  });
});
