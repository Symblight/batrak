import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $agentList } from '../../../stores/agents.js';
import { $agentViews, $sessionViews, forgetSessionView, setAgentView } from '../../../stores/session-views.js';
import { $chatInserts, addToChat } from '../../../stores/chat.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions.js';
import { $sessionNotices, setSessionNotice } from '../../../stores/session-runtime.js';
import { $cliStarting, $terminals, addSessionTerminal, setCliStarting, terminalExited } from '../../../stores/terminals.js';
import { $workspace } from '../../../stores/workspace.js';
import { $fileDropTarget } from '../../../stores/file-drop.js';
import { osScale } from '../../../models/file-drop.js';
import { platformOf } from '../../../models/platform.js';
import { shellPaths } from '../../../models/shell-paths.js';
import { fileDrop } from '../../../services/file-drop.js';
import '../acp-agent-column.js';

/** @typedef {import('../acp-agent-column.js').AcpAgentColumn} AcpAgentColumn */
/** @typedef {import('../../../models/types.js').Session} Session */
/** @typedef {import('../../../models/types.js').AgentSummary} AgentSummary */

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
      if (cmd === 'read_dropped_file') return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
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

    const send = new CustomEvent('chx-send-message', { detail: { value: 'fix the build' }, bubbles: true, composed: true, cancelable: true });
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
    $chatInserts.set([]);
    $cliStarting.set([]);
    $agentList.set({ ...$agentList.get(), agents: [] });
    clearMocks();
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
    expect(header(el).indicator, 'its CLI exited').to.equal('elsewhere');
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
    expect($chatInserts.get(), 'taken').to.deep.equal([]);
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
    /** @type {import('../../../models/types.js').ChatFile[]} */
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

  it('attaches an image dropped on the chat, read through the backend', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {{ files: File[], source: string | undefined }[]} */
    const added = [];
    chat.attachments.addFiles = (files, source) => added.push({ files: [...files], source });
    /** @type {import('../../../models/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    fileDrop.handle({ type: 'drop', paths: ['/Users/me/Screen Shot.png'], position: osPointOf(chat) });
    await until(() => added.length > 0);
    expect(added).to.have.length(1);
    const [file] = added[0].files;
    expect([file.name, file.type, file.size, added[0].source]).to.deep.equal(['Screen Shot.png', 'image/png', 4, 'drop']);
    expect(inserted, 'no chip').to.deep.equal([]);
  });

  it('drops nothing into the composer of a session shown after the files were dropped', async () => {
    /** @type {(kinds: string[]) => void} */
    let answer = () => {};
    mockIPC((cmd) => (cmd === 'dropped_kinds' ? new Promise((resolve) => (answer = resolve)) : null));
    $sessions.set([session(), session({ id: 's2' })]);
    $activeSessionId.set('s1');
    const { el, root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types.js').ChatFile[]} */
    const inserted = [];
    chat.insertFiles = (files) => inserted.push(...files);
    fileDrop.handle({ type: 'drop', paths: ['/p/a.js'], position: osPointOf(chat) });
    $activeSessionId.set('s2');
    await el.updateComplete;
    answer(['file']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inserted).to.deep.equal([]);
  });

  it('does nothing to the chat for files dropped on it while the terminal shows', async () => {
    $sessions.set([session()]);
    $sessionViews.setKey('s1', 'terminal');
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    $activeSessionId.set('s1');
    const { root } = await render();
    const chat = /** @type {HTMLElementTagNameMap['acp-chat']} */ (root.querySelector('acp-chat'));
    /** @type {import('../../../models/types.js').ChatFile[]} */
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
    expect($chatInserts.get(), 'waiting').to.have.length(1);

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
      expect($chatInserts.get()).to.deep.equal([]);
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
    /** @type {import('../../../models/types.js').ChatInsert[]} */
    const inserted = [];
    chat.insertCode = (inserts) => inserted.push(...inserts);
    addToChat([{ path: '/p/a.js', fromLine: 1, toLine: 1, body: '' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect($chatInserts.get(), 'waiting').to.have.length(1);

    const terminal = /** @type {HTMLElement} */ (root.querySelector('acp-terminal'));
    terminal.dispatchEvent(new CustomEvent('acp-terminal-chat', { bubbles: true, composed: true }));
    await until(() => !chat.hidden);
    await el.updateComplete;
    await until(() => inserted.length > 0);
    expect(inserted).to.deep.equal([{ path: '/p/a.js', fromLine: 1, toLine: 1, body: '' }]);
    expect($chatInserts.get(), 'taken').to.deep.equal([]);
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
