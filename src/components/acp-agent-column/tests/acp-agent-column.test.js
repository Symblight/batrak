import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $agentList } from '../../../stores/agents.js';
import { $agentViews, $sessionViews, forgetSessionView, setAgentView } from '../../../stores/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions.js';
import { $sessionNotices, setSessionNotice } from '../../../stores/session-runtime.js';
import { $terminals, addSessionTerminal } from '../../../stores/terminals.js';
import { $workspace } from '../../../stores/workspace.js';
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

/** @param {AcpAgentColumn} el */
const header = (el) => /** @type {HTMLElementTagNameMap['acp-session-header']} */ (el.shadowRoot?.querySelector('acp-session-header'));

describe('acp-agent-column', () => {
  beforeEach(() => {
    calls = [];
    mockIPC((cmd) => {
      calls.push(cmd);
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
