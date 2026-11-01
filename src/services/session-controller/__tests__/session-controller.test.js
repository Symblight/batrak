import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { sessionController } from '../session-controller.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { $historyResets } from '../../../stores/chat/chat.js';
import { $activeShownView, $agentViews, $sessionViews, forgetSessionView, setAgentView } from '../../../stores/session-views/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $terminals, sessionTerminalOf } from '../../../stores/terminals/terminals.js';
import { $workspace } from '../../../stores/workspace/workspace.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */

/** @param {Partial<Session>} [fields] */
function session(fields = {}) {
  return /** @type {Session} */ ({ id: 's1', projectId: '/p', title: 'T', agentId: 'claude', agentName: 'Claude Code', status: 'stopped', folder: '/p/sub', lastActivityAt: '', ...fields });
}

describe('sessionController views', () => {
  /** @type {{ cmd: string, args: unknown }[]} */
  let calls = [];
  /** @type {(cmd: string) => unknown} */
  let answer = () => null;

  beforeEach(() => {
    calls = [];
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null);
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      const value = answer(cmd);
      if (value instanceof Error) throw value;
      return value;
    });
  });

  afterEach(() => {
    for (const id of Object.keys($sessionViews.get())) forgetSessionView(id);
    $agentViews.set({});
    $terminals.set({});
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $historyResets.set([]);
    $workspace.set(null);
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
    clearMocks();
  });

  /** @param {string} cmd */
  const sent = (cmd) => calls.filter((c) => c.cmd === cmd);

  it("stops a running agent, then continues the session in its CLI", async () => {
    $sessions.set([session({ status: 'idle' })]);
    await sessionController.continueInTerminal('s1');
    expect(calls.map((c) => c.cmd).filter((c) => c.startsWith('session_'))).to.deep.equal(['session_stop', 'session_open_cli']);
    expect(sent('session_open_cli')[0].args).to.deep.include({ sessionId: 's1' });
    expect(sessionTerminalOf('s1')).to.equal('t-cli');
    expect($terminals.get()['t-cli']).to.include({ status: 'running', sessionId: 's1', cwd: '/p/sub', label: 'Claude Code' });
    expect($sessionViews.get()).to.deep.equal({ s1: 'terminal' });
  });

  it("opens a terminal in a session's folder and shows the session", async () => {
    // Arrange
    $workspace.set({ path: '/p', name: 'p', rootId: 'root:/p' });
    $sessions.set([session({ id: 's1' }), session({ id: 's2', folder: '/p/other' })]);
    // Act
    await sessionController.openInTerminal('s2');
    // Assert
    expect($activeSessionId.get()).to.equal('s2');
    expect(Object.values($terminals.get()).map((t) => [t.cwd, t.fallback, t.label])).to.deep.equal([['/p/other', '/p', 'other']]);
  });

  it("opens no terminal for an unknown session, or when its project can't be opened", async () => {
    // Arrange
    $sessions.set([session({ id: 's1', projectId: '/gone' })]);
    answer = (cmd) => (cmd === 'open_workspace' ? new Error('no such folder') : null);
    // Act
    await sessionController.openInTerminal('nope');
    await sessionController.openInTerminal('s1');
    // Assert
    expect($terminals.get()).to.deep.equal({});
    expect($activeSessionId.get()).to.equal(null);
  });

  it('starts the CLI once however many ask meanwhile', async () => {
    $sessions.set([session()]);
    await Promise.all([sessionController.continueInTerminal('s1'), sessionController.continueInTerminal('s1')]);
    expect(sent('session_open_cli')).to.have.length(1);
  });

  it("shows why the CLI didn't start in its place", async () => {
    $sessions.set([session()]);
    answer = (cmd) => (cmd === 'session_open_cli' ? new Error('codex: not found') : null);
    await sessionController.continueInTerminal('s1');
    const id = /** @type {string} */ (sessionTerminalOf('s1'));
    expect($terminals.get()[id]).to.include({ status: 'failed' });
    expect($terminals.get()[id].error).to.include('codex: not found');
  });

  it('closes the CLI and resumes the agent to continue in chat', async () => {
    $sessions.set([session()]);
    await sessionController.continueInTerminal('s1');
    calls = [];
    await sessionController.continueInChat('s1');
    expect(calls.map((c) => c.cmd).filter((c) => c.startsWith('session_'))).to.deep.equal(['session_close_cli', 'session_resume']);
    expect(sessionTerminalOf('s1')).to.equal(null);
    expect($sessionViews.get()).to.deep.equal({});
  });

  it('closes the terminal of a CLI that exited when continuing in chat', async () => {
    $sessions.set([session()]);
    await sessionController.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    calls = [];
    await sessionController.continueInChat('s1');
    expect(sent('terminal_close').map((c) => c.args)).to.deep.equal([{ ids: ['t-cli'] }]);
    expect(sessionTerminalOf('s1')).to.equal(null);
  });

  it('closes the terminal of a removed session whose CLI exited', async () => {
    $sessions.set([session()]);
    await sessionController.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    await sessionController.remove('s1');
    expect(sent('terminal_close').map((c) => c.args)).to.deep.equal([{ ids: ['t-cli'] }]);
  });

  it('starts an exited CLI again on Restart', async () => {
    $sessions.set([session()]);
    await sessionController.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli-2' } : null);
    await sessionController.restartCli('s1');
    expect(sessionTerminalOf('s1')).to.equal('t-cli-2');
    expect($terminals.get()['t-cli']).to.equal(undefined);
  });
});

describe('sessionController keeps the active session in its view', () => {
  /** @type {{ cmd: string, args: unknown }[]} */
  let calls = [];
  let busy = false;
  /** @type {Error | null} What `session_open_cli` fails with. */
  let cliFails = null;

  beforeEach(() => {
    calls = [];
    busy = false;
    cliFails = null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'session_open_cli' && cliFails) throw cliFails;
      if (cmd === 'session_open_cli') return { terminalId: 't-cli' };
      if (cmd === 'session_cli_busy') return busy;
      return null;
    });
    $agentList.set({
      ...$agentList.get(),
      defaultAgent: 'claude',
      agents: [/** @type {import('../../../models/types/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })],
    });
  });

  afterEach(() => {
    for (const id of Object.keys($sessionViews.get())) forgetSessionView(id);
    $agentViews.set({});
    $terminals.set({});
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $historyResets.set([]);
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
    clearMocks();
  });

  /** Commands sent to the backend about sessions and terminals, in order. */
  const sent = () => calls.map((c) => c.cmd).filter((c) => c.startsWith('session_') || c.startsWith('terminal_'));

  it("shows a session whose agent's sessions open in the terminal as its terminal at once, never as chat", async () => {
    /** @type {(value: null) => void} */
    let synced = () => {};
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'sessions_sync') return new Promise((resolve) => (synced = resolve));
      if (cmd === 'session_open_cli') return { terminalId: 't-cli' };
      return null;
    });
    $sessions.set([session()]);
    setAgentView('claude', 'terminal');
    $activeSessionId.set('s1');
    const shown = sessionController.show('s1');
    expect($activeShownView.get(), 'decided by its agent, before its list arrives').to.equal('terminal');
    synced(null);
    await shown;
    expect(sent()).to.include('session_open_cli');
    expect(sent(), 'its chat agent never resumed').not.to.include('session_resume');
    expect($activeShownView.get()).to.equal('terminal');
  });

  it('shows a session with a running turn as chat while its agent opens sessions in the terminal', async () => {
    $sessions.set([session({ status: 'working' })]);
    setAgentView('claude', 'terminal');
    $activeSessionId.set('s1');
    const shown = sessionController.show('s1');
    expect($activeShownView.get()).to.equal('chat');
    await shown;
    expect(sent(), 'its turn left alone').not.to.include('session_stop');
  });

  it("opens the CLI of a shown session whose agent's sessions open in the terminal", async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    expect($activeShownView.get()).to.equal('chat');
    setAgentView('claude', 'terminal');
    await sessionController.reconcile();
    expect(sent()).to.deep.equal(['session_open_cli']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it('leaves a running turn alone, and opens the CLI once it ends', async () => {
    $sessions.set([session({ status: 'working' })]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessionController.reconcile();
    expect(sent(), 'nothing stopped').to.deep.equal([]);
    expect($activeShownView.get()).to.equal('chat');

    $sessions.set([session({ status: 'idle' })]);
    await sessionController.reconcile();
    expect(sent()).to.deep.equal(['session_stop', 'session_open_cli']);
  });

  it('closes an idle CLI when the agent\'s sessions go back to chat, and resumes the agent with its history', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessionController.reconcile();
    calls = [];
    setAgentView('claude', 'chat');
    await sessionController.reconcile();
    expect(sent()).to.deep.equal(['session_cli_busy', 'session_close_cli', 'session_resume']);
    expect($activeShownView.get()).to.equal('chat');
    expect($historyResets.get()).to.deep.equal(['s1']);
  });

  it('keeps a busy CLI when the agent\'s sessions go back to chat', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessionController.reconcile();
    busy = true;
    calls = [];
    setAgentView('claude', 'chat');
    await sessionController.reconcile();
    expect(sent()).to.deep.equal(['session_cli_busy']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it("shows a draft's composer even when its agent's sessions open in the terminal", async () => {
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    await sessionController.reconcile();
    expect(sent(), 'no CLI before its first message').to.deep.equal([]);
    expect($activeShownView.get()).to.equal('chat');
    expect(sessionController.startsInTerminal('d1')).to.equal(true);
  });

  it("starts a draft's CLI with its first message and the draft's choices", async () => {
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    await sessionController.startInTerminal('d1', 'Fix the build', 'fix the build please');
    const open = calls.find((c) => c.cmd === 'session_open_cli');
    expect(open?.args).to.deep.include({ sessionId: 'd1' });
    expect(/** @type {{ draft: Record<string, unknown> }} */ (open?.args).draft).to.include({
      projectPath: '/p',
      agentId: 'claude',
      mode: 'local',
      title: 'Fix the build',
      prompt: 'fix the build please',
    });
    expect($sessions.get().map((s) => s.id), 'listed').to.deep.equal(['d1']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it("answers whether a draft's CLI started: a refused one is a draft again", async () => {
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    cliFails = new Error('no npx');
    expect(await sessionController.startInTerminal('d1', 'T', 'go')).to.equal(false);
    expect($draftSessions.get()).to.have.property('d1');
    cliFails = null;
    expect(await sessionController.startInTerminal('d1', 'T', 'go')).to.equal(true);
  });

  it("sends a draft's first message to the chat when its agent's CLI can't start a session", async () => {
    $agentList.set({
      ...$agentList.get(),
      agents: [/** @type {import('../../../models/types/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: false } })],
    });
    $draftSessions.set({ d1: '/p' });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    expect(sessionController.startsInTerminal('d1')).to.equal(false);
    setAgentView('claude', 'chat');
    expect(sessionController.startsInTerminal('d1'), 'its agent opens sessions as chat').to.equal(false);
  });
});
