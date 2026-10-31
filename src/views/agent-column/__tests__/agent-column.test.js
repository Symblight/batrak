import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { $agentViews, $sessionViews, forgetSessionView, setAgentView } from '../../../stores/session-views/session-views.js';
import { $pendingInput, addToChat, hasPendingInput } from '../../../stores/chat/chat.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $sessionNotices, setSessionNotice } from '../../../stores/session-runtime/session-runtime.js';
import { $cliStarting, $terminals, addSessionTerminal, setCliStarting, terminalExited } from '../../../stores/terminals/terminals.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import { $fileDropTarget } from '../../../stores/file-drop/file-drop.js';
import { osScale } from '../../../models/file-drop/file-drop.js';
import { platformOf } from '../../../models/platform/platform.js';
import { shellPaths } from '../../../models/shell-paths/shell-paths.js';
import { fileDrop } from '../../../services/file-drop/file-drop.js';
import { $notices } from '../../../stores/notices/notices.js';
import '../agent-column.js';

/** @typedef {import('../agent-column.js').AcpAgentColumn} AcpAgentColumn */
/** @typedef {import('../../../models/types/types.js').Session} Session */
/** @typedef {import('../../../models/types/types.js').AgentSummary} AgentSummary */

/** @param {Partial<Session>} [fields] */
function session(fields = {}) {
  return /** @type {Session} */ ({
    id: 's1',
    projectId: '/p',
    title: 'Fix the tree',
    titleSource: 'agent',
    agentTitle: 'Fix the tree',
    status: 'stopped',
    agentId: 'claude',
    agentName: 'Claude Code',
    config: {},
    mode: 'local',
    folder: '/p',
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-10-30T10:00:00.000Z',
    lastActivityAt: '2026-10-30T10:00:00.000Z',
    ...fields,
  });
}

/** @type {string[]} */
let calls = [];

async function render() {
  const el = /** @type {AcpAgentColumn} */ (await fixture(html`<acp-agent-column style="display: flex; height: 500px"></acp-agent-column>`));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * The center of `el`, in the units the webview's drag events use on this platform.
 * @param {Element} el
 */
function osPointOf(el) {
  const r = el.getBoundingClientRect();
  const scale = osScale(platformOf(navigator.userAgent), devicePixelRatio);
  return { x: (r.left + r.width / 2) * scale, y: (r.top + r.height / 2) * scale };
}

/**
 * Waits until `done()` holds (the column's drop handling awaits the backend).
 * @param {() => boolean} done
 */
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** @param {AcpAgentColumn} el */
const header = (el) => /** @type {HTMLElementTagNameMap['acp-session-header']} */ (el.shadowRoot?.querySelector('acp-session-header'));

describe('acp-agent-column', () => {
  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push(cmd);
      if (cmd === 'dropped_kinds') {
        const { paths } = /** @type {{ paths: string[] }} */ (args);
        return paths.map((p) => (p.endsWith('/src') || p.endsWith('/docs') ? 'folder' : 'file'));
      }
      if (cmd === 'session_open_cli') return { terminalId: 't-cli' };
      if (cmd === 'session_cli_busy') return false;
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $agentList.set({
      ...$agentList.get(),
      defaultAgent: 'claude',
      agents: [/** @type {AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })],
    });
  });

  it("shows a new session's composer, and its first message starts the CLI when its agent's sessions open in the terminal", async () => {
    setAgentView('claude', 'terminal');
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    const { el, root } = await render();
    expect(/** @type {HTMLElement} */ (root.querySelector('acp-chat')).hidden, 'the composer').to.equal(false);
    expect(calls, 'nothing started yet').not.to.include('session_open_cli');

    const send = new CustomEvent('chx-send-message', { detail: { value: 'fix the build', html: '<div>fix the build</div>', attachments: [] }, bubbles: true, composed: true, cancelable: true });
    /** @type {HTMLElement} */ (root.querySelector('acp-chat')).dispatchEvent(send);
    expect(send.defaultPrevented, 'not sent to the chat').to.equal(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
    expect(calls).to.include('session_open_cli');
    expect(root.querySelector('acp-terminal'), 'the terminal').not.to.equal(null);
  });

  afterEach(() => {
    for (const el of document.querySelectorAll('acp-agent-column')) el.parentElement?.remove();
    for (const id of Object.keys($sessionViews.get())) forgetSessionView(id);
    $terminals.set({});
    $activeSessionId.set(null);
    $sessions.set([]);
    $draftSessions.set({});
    $agentViews.set({});
    $workspace.set(null);
    $sessionNotices.set({});
    $pendingInput.set({});
    $cliStarting.set([]);
    $agentList.set({ ...$agentList.get(), agents: [] });
    clearMocks();
  });

  it("shows the model and permission pickers for a new session that starts in the terminal: its CLI starts with them", async () => {
    setAgentView('claude', 'terminal');
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    await chat.updateComplete;
    expect(chat.renderRoot.querySelector('acp-model-picker'), 'model').not.to.equal(null);
    expect(chat.renderRoot.querySelector('acp-mode-picker'), 'permissions').not.to.equal(null);
  });

  it('shows the chat, not a spinner, while a terminal view waits for a running turn to end', async () => {
    $sessions.set([session({ status: 'working' })]);
    $sessionViews.setKey('s1', 'terminal');
    $activeSessionId.set('s1');
    const { el, root } = await render();
    expect(/** @type {HTMLElement} */ (root.querySelector('acp-chat')).hidden).to.equal(false);
    expect(root.querySelector('acp-terminal')).to.equal(null);
    expect(root.querySelector('md-progress-circular')).to.equal(null);
    expect(header(el).view, 'the header says what is shown').to.equal('chat');
  });

  it("takes whether a session is in the terminal from the backend's record only", async () => {
    $sessions.set([session({ inTerminal: false, activeElsewhereUntil: new Date(Date.now() + 60_000).toISOString() })]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    $activeSessionId.set('s1');
    const { el } = await render();
    const status = /** @type {HTMLElementTagNameMap['acp-session-status'] | null} */ (header(el).shadowRoot?.querySelector('acp-session-status'));
    expect(status?.indicator, 'its CLI exited').to.equal('elsewhere');
  });

  it('shows no chat banner above a terminal session', async () => {
    $sessions.set([session({ inTerminal: true })]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    setSessionNotice('s1', { kind: 'error', message: 'Claude Code is off' });
    const { root } = await render();
    expect(root.querySelector('acp-session-banner')).to.equal(null);
  });

  it("shows a terminal session's CLI in place of the chat, which stays hidden", async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const chat = /** @type {HTMLElement} */ (root.querySelector('acp-chat'));
    expect(chat.hidden).to.equal(true);
    const terminal = root.querySelector('acp-terminal');
    expect(terminal?.terminalId).to.equal('t-cli');
    expect(header(el).view).to.equal('terminal');
  });

  it("types code sent from the editors into a terminal session's CLI, as @ refs", async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { root } = await render();
    const terminal = /** @type {HTMLElementTagNameMap['acp-terminal']} */ (root.querySelector('acp-terminal'));
    /** @type {string[]} */
    const pasted = [];
    terminal.paste = (text) => pasted.push(text);
    addToChat([
      { path: '/p/src/app.js', fromLine: 3, toLine: 5, body: '' },
      { path: '/p/src/app.js', fromLine: 9, toLine: 9, body: 'Rename this' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasted).to.deep.equal(['@src/app.js#L3-5 \n@src/app.js#L9 Rename this']);
    expect(hasPendingInput('s1'), 'taken').to.equal(false);
  });

  it("types files dropped on a terminal session's CLI as their escaped paths, and marks it while they're dragged over", async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const terminal = /** @type {HTMLElementTagNameMap['acp-terminal']} */ (root.querySelector('acp-terminal'));
    /** @type {string[]} */
    const pasted = [];
    terminal.paste = (text) => pasted.push(text);
    const paths = ['/Users/me/Screen Shot.png', '/Users/me/notes.md'];
    fileDrop.handle({ type: 'enter', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    expect(terminal.dropping, 'marked').to.equal(true);
    fileDrop.handle({ type: 'drop', paths, position: osPointOf(terminal) });
    await el.updateComplete;
    expect(terminal.dropping, 'unmarked').to.equal(false);
    await until(() => pasted.length > 0);
    expect(pasted).to.deep.equal([shellPaths(paths, platformOf(navigator.userAgent))]);
  });

  it('types nothing for files dropped outside its terminal', async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { root } = await render();
    const terminal = /** @type {HTMLElementTagNameMap['acp-terminal']} */ (root.querySelector('acp-terminal'));
    /** @type {string[]} */
    const pasted = [];
    terminal.paste = (text) => pasted.push(text);
    const header = /** @type {Element} */ (root.querySelector('acp-session-header'));
    fileDrop.handle({ type: 'drop', paths: ['/a.png'], position: osPointOf(header) });
    expect(pasted).to.deep.equal([]);
    expect($fileDropTarget.get()).to.equal(null);
  });

  it("inserts files dropped on the chat as chips, relative to the session's folder inside it, and marks it while they're dragged over", async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    const paths = ['/p/src/app.js', '/p/src', '/Users/me/notes.md', '/Users/me/docs'];
    fileDrop.handle({ type: 'enter', paths, position: osPointOf(chat) });
    await el.updateComplete;
    expect(chat.dropping, 'marked').to.equal(true);
    fileDrop.handle({ type: 'drop', paths, position: osPointOf(chat) });
    await el.updateComplete;
    expect(chat.dropping, 'unmarked').to.equal(false);
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([
      { path: 'src/app.js', folder: false },
      { path: 'src', folder: true },
      { path: '/Users/me/notes.md', folder: false },
      { path: '/Users/me/docs', folder: true },
    ]);
  });

  it('inserts an image dropped on the chat as a chip, like any file: nothing to attach', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    fileDrop.handle({ type: 'drop', paths: ['/Users/me/Screen Shot.png'], position: osPointOf(chat) });
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([{ path: '/Users/me/Screen Shot.png', folder: false }]);
  });

  it("saves files attached in the composer into the session's folder and puts their path chips in", async () => {
    /** @type {{ headers?: Record<string, string> }[]} */
    const saved = [];
    mockIPC(() => null);
    // `mockIPC` leaves out the options, where a raw body's folder and name go.
    const internals = /** @type {{ invoke: (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> }} */ (
      /** @type {{ __TAURI_INTERNALS__: unknown }} */ (/** @type {unknown} */ (window)).__TAURI_INTERNALS__
    );
    internals.invoke = async (cmd, _args, options) => {
      if (cmd !== 'save_attachment') return null;
      saved.push({ headers: options?.headers });
      return `/p/.brama/attachments/${decodeURIComponent(options?.headers?.name ?? '')}`;
    };
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    const files = [new File(['x'], 'Screen Shot é.png'), new File(['y'], 'log.txt')];
    chat.dispatchEvent(new CustomEvent('acp-chat-attach', { detail: { files }, bubbles: true, composed: true }));
    await until(() => inserted.length === 2);
    expect(saved.map((c) => c.headers)).to.deep.equal([
      { folder: '%2Fp', name: 'Screen%20Shot%20%C3%A9.png' },
      { folder: '%2Fp', name: 'log.txt' },
    ]);
    expect(inserted).to.deep.equal([
      { path: '.brama/attachments/Screen Shot é.png', folder: false },
      { path: '.brama/attachments/log.txt', folder: false },
    ]);
  });

  it('puts in the chips of the files that saved and names the ones that failed', async () => {
    mockIPC(() => null);
    const internals = /** @type {{ invoke: (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> }} */ (
      /** @type {{ __TAURI_INTERNALS__: unknown }} */ (/** @type {unknown} */ (window)).__TAURI_INTERNALS__
    );
    internals.invoke = async (cmd, _args, options) => {
      if (cmd !== 'save_attachment') return null;
      const name = decodeURIComponent(options?.headers?.name ?? '');
      if (name === 'bad.txt') throw new Error('bad.txt: disk full');
      return `/p/.brama/attachments/${name}`;
    };
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    const files = [new File(['x'], 'a.txt'), new File(['y'], 'bad.txt')];
    chat.dispatchEvent(new CustomEvent('acp-chat-attach', { detail: { files }, bubbles: true, composed: true }));
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([{ path: '.brama/attachments/a.txt', folder: false }]);
    expect($notices.get().map((n) => n.message).join()).to.contain('bad.txt: disk full');
  });

  it("refuses a send with attachments, which the agent can't be sent yet: the composer keeps them, the agent gets nothing", async () => {
    $sessions.set([session({ status: 'idle' })]);
    setSessionNotice('s1', { kind: 'outdated', message: 'agents.json changed' });
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElement} */ (root.querySelector('acp-chat'));
    const detail = { value: 'look', html: '<div>look</div>', attachments: [new File(['x'], 'shot.png')] };
    const send = new CustomEvent('chx-send-message', { detail, bubbles: true, composed: true, cancelable: true });
    chat.dispatchEvent(send);
    expect(send.defaultPrevented, 'cancelled: the composer keeps it').to.equal(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((c) => c.startsWith('session_')), 'nothing sent').to.deep.equal([]);
    const notice = $sessionNotices.get().s1;
    expect(notice).to.include({ kind: 'info' });
    expect(notice?.message).to.contain('shot.png');
    expect(notice?.under, 'the notice it covers comes back once dismissed').to.deep.equal({ kind: 'outdated', message: 'agents.json changed' });
  });

  it('drops nothing into the composer of a session shown after the files were dropped', async () => {
    /** @type {(kinds: string[]) => void} */
    let answer = () => {};
    mockIPC((cmd) => (cmd === 'dropped_kinds' ? new Promise((resolve) => (answer = resolve)) : null));
    $sessions.set([session(), session({ id: 's2' })]);
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    fileDrop.handle({ type: 'drop', paths: ['/p/a.js'], position: osPointOf(chat) });
    $activeSessionId.set('s2');
    await el.updateComplete;
    answer(['file']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inserted).to.deep.equal([]);
    expect($pendingInput.get().s1, 'kept for the session it was dropped on').to.deep.equal({ inserts: [], drops: ['/p/a.js'] });
  });

  it("keeps files dropped on a terminal session's ended CLI, says so, and puts them into the composer once the chat shows", async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    terminalExited('t-cli', { code: 1, signal: null });
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const terminal = /** @type {HTMLElementTagNameMap['acp-terminal']} */ (root.querySelector('acp-terminal'));
    /** @type {string[]} */
    const pasted = [];
    terminal.paste = (text) => pasted.push(text);
    fileDrop.handle({ type: 'drop', paths: ['/p/src/app.js'], position: osPointOf(terminal) });
    await el.updateComplete;
    expect(pasted, 'not into an ended CLI').to.deep.equal([]);
    expect(terminal.waiting).to.equal(1);

    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    terminal.dispatchEvent(new CustomEvent('acp-terminal-chat', { bubbles: true, composed: true }));
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([{ path: 'src/app.js', folder: false }]);
    expect(hasPendingInput('s1')).to.equal(false);
  });

  it('does nothing to the chat for files dropped on it while the terminal shows', async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    fileDrop.dispatchEvent(new CustomEvent('drop', { detail: { target: chat, paths: ['/p/a.js'] } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inserted).to.deep.equal([]);
    expect(calls).not.to.include('dropped_kinds');
  });

  it('keeps code sent while the CLI starts until its terminal shows', async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    setCliStarting('s1', true);
    $activeSessionId.set('s1');
    const { el, root } = await render();
    addToChat([{ path: '/p/a.js', fromLine: 1, toLine: 1, body: '' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasPendingInput('s1'), 'waiting').to.equal(true);

    /** @type {string[]} */
    const pasted = [];
    const proto = /** @type {HTMLElementTagNameMap['acp-terminal']} */ (customElements.get('acp-terminal')?.prototype);
    const { paste } = proto;
    proto.paste = (text) => pasted.push(text);
    try {
      addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
      setCliStarting('s1', false);
      await el.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.querySelector('acp-terminal')).not.to.equal(null);
      expect(pasted).to.deep.equal(['@a.js#L1 ']);
      expect(hasPendingInput('s1')).to.equal(false);
    } finally {
      proto.paste = paste;
    }
  });

  it("puts code sent while a terminal session's CLI has ended into the composer once the chat shows", async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    terminalExited('t-cli', { code: 1, signal: null });
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types/types.js').ChatInsert[]} */
    const inserted = [];
    chat.insertCode = (inserts) => inserted.push(...inserts);
    addToChat([{ path: '/p/a.js', fromLine: 1, toLine: 1, body: '' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasPendingInput('s1'), 'waiting').to.equal(true);

    const terminal = /** @type {HTMLElement} */ (root.querySelector('acp-terminal'));
    terminal.dispatchEvent(new CustomEvent('acp-terminal-chat', { bubbles: true, composed: true }));
    await until(() => !chat.hidden);
    await el.updateComplete;
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([{ path: '/p/a.js', fromLine: 1, toLine: 1, body: '' }]);
    expect(hasPendingInput('s1'), 'taken').to.equal(false);
  });

  it('asks before stopping a running turn to continue in the terminal; Cancel changes nothing', async () => {
    $sessions.set([session({ status: 'working' })]);
    $activeSessionId.set('s1');
    const { el, root } = await render();
    header(el).dispatchEvent(new CustomEvent('acp-session-view', { detail: { sessionId: 's1', view: 'terminal' }, bubbles: true, composed: true }));
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
    await dialog.updateComplete;
    expect(dialog.options?.confirmLabel).to.equal('Stop and continue');
    dialog.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).to.not.include('session_open_cli');
    expect(calls).to.not.include('session_stop');
    expect($sessionViews.get()).to.deep.equal({});
  });
});
