import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { agentsMd } from '../../../hooks/agents-md/agents-md.js';
import { sessions } from '../../../hooks/sessions/sessions.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { offerAgentsMdAgain } from '../../../stores/agents-md/agents-md.js';
import { forgetComposer } from '../../../stores/composer/composer.js';
import { $project } from '../../../stores/project/project.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
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
    offerAgentsMdAgain();
    forgetComposer('d1');
    forgetComposer('d2');
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $project.set(null);
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
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

  /** @param {AcpChatView} el Presses the banner's dismiss button. */
  async function dismiss(el) {
    const banner = /** @type {import('lit').LitElement} */ (chat(el).renderRoot.querySelector('acp-session-banner'));
    await banner.updateComplete;
    const inner = /** @type {import('lit').LitElement} */ (banner.renderRoot.querySelector('chx-input-mode-banner'));
    await inner.updateComplete;
    /** @type {HTMLElement} */ (inner.renderRoot.querySelector('[part="dismiss"]')).click();
    await el.updateComplete;
  }

  it('its dismiss button hides the offer on this view, whatever else happens on it', async () => {
    // Arrange: the root lacks the file
    answer = (cmd) => cmd === 'needs_agents_md';
    const el = await render();
    await until(() => chat(el).agentsMdOffer);

    // Act
    await dismiss(el);

    // Assert
    expect(chat(el).agentsMdOffer, 'gone at once').to.equal(false);

    // Act: the root's listing changes, and the backend still says it lacks the file
    const before = asked().length;
    await rootChanged(['']);
    await until(() => asked().length > before);
    await settled();

    // Assert
    expect(chat(el).agentsMdOffer, 'after asking again').to.equal(false);

    // Act: away to no session, and back to the same draft
    $activeSessionId.set(null);
    await el.updateComplete;
    $activeSessionId.set('d1');
    await until(() => asked().length > before + 1);
    await settled();

    // Assert
    expect(chat(el).agentsMdOffer, 'back on the same draft').to.equal(false);
  });

  it('a new session offers it again after a dismissal', async () => {
    const cases = [
      {
        how: 'New chat on the shown draft, which it reuses',
        open: () => sessions.create('/p'),
      },
      {
        how: 'New chat from no session, reusing the draft',
        open: () => {
          $activeSessionId.set(null);
          sessions.create('/p');
        },
      },
      {
        how: 'another draft shown',
        open: () => {
          $draftSessions.set({ ...$draftSessions.get(), d2: { projectId: '/p', workspaceId: 'main' } });
          $activeSessionId.set('d2');
        },
      },
    ];
    for (const { how, open } of cases) {
      // Arrange
      answer = (cmd) => cmd === 'needs_agents_md';
      $activeSessionId.set('d1');
      const el = await render();
      await until(() => chat(el).agentsMdOffer);
      await dismiss(el);
      expect(chat(el).agentsMdOffer, `${how}: dismissed first`).to.equal(false);

      // Act
      open();

      // Assert
      await until(() => chat(el).agentsMdOffer);
    }
  });

  it('Create AGENTS.md only fills the composer and hides the offer on this view; its send starts a session titled after the prompt with the whole prompt', async () => {
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
    await settled();

    // Assert
    expect(calls.map((c) => c.cmd), 'nothing started').to.not.include.members(['session_create', 'session_send_prompt']);
    expect(chat(el).agentsMdOffer, 'offer hidden').to.equal(false);

    // Act: the user sends it
    const composer = /** @type {import('lit').LitElement} */ (chat(el).renderRoot.querySelector('chx-message-composer'));
    /** @type {HTMLElement} */ (composer.renderRoot.querySelector('chx-textbox')).closest('form')?.requestSubmit();
    await until(() => calls.some((c) => c.cmd === 'session_send_prompt'));

    // Assert
    const create = calls.find((c) => c.cmd === 'session_create')?.args;
    expect(create?.title).to.equal('Create AGENTS.md for this project');
    expect(create?.agentId).to.equal('claude');
    const prompt = /** @type {{ text?: string }[]} */ (calls.find((c) => c.cmd === 'session_send_prompt')?.args.prompt);
    expect(prompt.map((p) => p.text).join('')).to.equal(agentsMd.PROMPT);
  });
});
