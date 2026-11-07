import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { agentsMd } from '../../../hooks/agents-md/agents-md.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { forgetComposer } from '../../../stores/composer/composer.js';
import { $openRoots, $project } from '../../../stores/project/project.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
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

/** Lets what was asked answer, and the view render it. */
const settled = () => new Promise((r) => setTimeout(r, 20));

describe('acp-chat-view: the offer to create AGENTS.md', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string, args: Record<string, unknown>) => unknown} */
  let answer;

  const asked = () => calls.filter((c) => c.cmd === 'needs_agents_md').map((c) => c.args.rootId);

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
        return answer(cmd, /** @type {Record<string, unknown>} */ (args ?? {}));
      },
      { shouldMockEvents: true },
    );
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
  });

  afterEach(() => {
    forgetComposer('d1');
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $project.set(null);
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
    setWorkspaces([]);
    $openRoots.set({});
    for (const key of Object.keys(localStorage)) if (key.startsWith('batrak:agents-md:dismissed:')) localStorage.removeItem(key);
    clearMocks();
  });

  async function render() {
    const wrapper = await fixture(html`<div><acp-chat-view></acp-chat-view></div>`);
    const el = /** @type {AcpChatView} */ (wrapper.firstElementChild);
    await el.updateComplete;
    return el;
  }

  /** @param {AcpChatView} el */
  const chat = (el) => /** @type {HTMLElementTagNameMap['acp-chat']} */ (el.querySelector('acp-chat'));

  /** @param {string[]} dirs */
  const rootChanged = (dirs) => emit('roots://changed', { rootId: 'r', dirs, added: [], removed: [], modified: [], git: false });

  it('offers it while a draft shows a folder that lacks the file, and on nothing else', async () => {
    for (const needed of [true, false]) {
      // Arrange
      answer = (cmd) => (cmd === 'needs_agents_md' ? needed : null);
      calls = [];

      // Act
      const el = await render();
      await until(() => asked().length > 0);
      await settled();

      // Assert
      expect(chat(el).agentsMdOffer, `needed: ${needed}`).to.equal(needed);
      expect(asked(), 'about the shown root').to.deep.equal(['r']);
    }

    // Act: the draft goes away
    answer = (cmd) => (cmd === 'needs_agents_md' ? true : null);
    const el = await render();
    await until(() => chat(el).agentsMdOffer);
    $activeSessionId.set(null);
    await el.updateComplete;

    // Assert
    expect(chat(el).agentsMdOffer, 'no draft, no offer').to.equal(false);
  });

  it("asks again when the root's own listing changes, and only then", async () => {
    // Arrange
    let needed = true;
    answer = (cmd) => (cmd === 'needs_agents_md' ? needed : null);
    const el = await render();
    await until(() => chat(el).agentsMdOffer);
    await settled();
    const before = asked().length;

    // Act: a change in a subfolder
    needed = false;
    await rootChanged(['src']);
    await settled();

    // Assert
    expect(asked().length, 'a subfolder has no say').to.equal(before);
    expect(chat(el).agentsMdOffer).to.equal(true);

    // Act: AGENTS.md appears at the root
    await rootChanged(['']);
    await until(() => !chat(el).agentsMdOffer);

    // Assert
    expect(asked().length).to.equal(before + 1);
  });

  it('asks about the new root on a switch, dropping the late answer about the old', async () => {
    // Arrange: `r` answers late
    /** @type {(needed: boolean) => void} */
    let late = () => {};
    answer = (cmd, args) => {
      if (cmd !== 'needs_agents_md') return null;
      return args.rootId === 'r' ? new Promise((resolve) => (late = resolve)) : false;
    };
    const el = await render();
    await until(() => asked().length === 1);

    // Act
    $project.set({ path: '/q', name: 'q', rootId: 'r-q' });
    await until(() => asked().length === 2);
    late(true);
    await settled();

    // Assert
    expect(asked()).to.deep.equal(['r', 'r-q']);
    expect(chat(el).agentsMdOffer, "the old root's answer").to.equal(false);
  });

  it('offers nothing and reports nothing when the root is gone by the time it asks', async () => {
    // Arrange
    answer = (cmd) => {
      if (cmd === 'needs_agents_md') throw new Error('unknown root: r');
      return null;
    };
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {PromiseRejectionEvent} e What `app.init()` would report as an error. */
    const onUnhandled = (e) => {
      e.preventDefault();
      unhandled.push(e.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    // Act
    const el = await render();
    await until(() => asked().length > 0);
    await settled();
    window.removeEventListener('unhandledrejection', onUnhandled);

    // Assert
    expect(chat(el).agentsMdOffer).to.equal(false);
    expect(unhandled).to.deep.equal([]);
  });

  it('its dismiss button ends the offer for the project, in all its workspaces, and for no other', async () => {
    // Arrange: every root lacks the file; shown is a workspace of a project no other test has dismissed
    answer = (cmd) => cmd === 'needs_agents_md';
    const path = `/p-${crypto.randomUUID()}`;
    $project.set({ path, name: 'p', rootId: 'r' });
    const workspace = /** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', name: 'w1', folder: '/wt/w1', worktreePath: '/wt/w1', branch: 'w1', checkedOut: true });
    setWorkspaces([workspace], path);
    $openRoots.set({ '/wt/w1': 'r-w1' });
    setActiveWorkspace(path, 'w1');
    const el = await render();
    await until(() => chat(el).agentsMdOffer);
    expect(asked(), 'about the workspace').to.deep.equal(['r-w1']);
    const banner = /** @type {import('lit').LitElement} */ (chat(el).renderRoot.querySelector('acp-session-banner'));
    await banner.updateComplete;
    const inner = /** @type {import('lit').LitElement} */ (banner.renderRoot.querySelector('chx-input-mode-banner'));
    await inner.updateComplete;

    // Act
    /** @type {HTMLElement} */ (inner.renderRoot.querySelector('[part="dismiss"]')).click();
    await el.updateComplete;

    // Assert
    expect(chat(el).agentsMdOffer, 'gone at once').to.equal(false);

    // Act: Main of the same project, its root lacking the file too
    setActiveWorkspace(path, MAIN);
    await until(() => asked().includes('r'));
    await settled();

    // Assert
    expect(chat(el).agentsMdOffer, "the project's Main").to.equal(false);

    // Act: another project
    $project.set({ path: `/other-${crypto.randomUUID()}`, name: 'other', rootId: 'r-other' });

    // Assert
    await until(() => chat(el).agentsMdOffer);
  });

  it('Create AGENTS.md starts a session titled after the prompt and sends it the whole prompt', async () => {
    // Arrange
    answer = (cmd, args) => {
      if (cmd === 'needs_agents_md') return true;
      if (cmd === 'session_create') return { id: args.sessionId, projectId: '/p', title: args.title, agentId: 'claude', agentName: 'Claude Code', status: 'idle', folder: '/p', lastActivityAt: '' };
      if (cmd === 'session_send_prompt') return '2026-11-07T00:00:00Z';
      return null;
    };
    $agentList.set({ ...$agentList.get(), defaultAgent: 'claude', agents: [/** @type {import('../../../hooks/agents/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })] });
    const el = await render();
    await until(() => chat(el).agentsMdOffer);
    await chat(el).composerReady();
    const banner = /** @type {import('lit').LitElement} */ (chat(el).renderRoot.querySelector('acp-session-banner'));
    await banner.updateComplete;

    // Act
    /** @type {HTMLElement} */ (banner.renderRoot.querySelector('md-button')).click();
    await until(() => calls.some((c) => c.cmd === 'session_send_prompt'));

    // Assert
    const create = calls.find((c) => c.cmd === 'session_create')?.args;
    expect(create?.title).to.equal('Create AGENTS.md for this project');
    expect(create?.agentId).to.equal('claude');
    const prompt = /** @type {{ text?: string }[]} */ (calls.find((c) => c.cmd === 'session_send_prompt')?.args.prompt);
    expect(prompt.map((p) => p.text).join('')).to.equal(agentsMd.PROMPT);
  });
});
