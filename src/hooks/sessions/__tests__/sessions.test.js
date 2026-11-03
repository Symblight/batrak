import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { sessions } from '../sessions.js';
import { trackSeen } from '../seen.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { $historyResets } from '../../../stores/chat/chat.js';
import { $activeShownView, $agentViews, $sessionViews, forgetSessionView, setAgentView } from '../../../stores/session-views/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $cliStarting, $terminals, addSessionTerminal, sessionTerminalOf } from '../../../stores/terminals/terminals.js';
import { $sessionReads, forgetRead } from '../../../stores/session-read/session-read.js';
import { $project } from '../../../stores/project/project.js';
import { projects } from '../../projects/projects.js';

/** @typedef {import('../types.js').Session} Session */

/** @param {Partial<Session>} [fields] */
function session(fields = {}) {
  return /** @type {Session} */ ({ id: 's1', projectId: '/p', title: 'T', agentId: 'claude', agentName: 'Claude Code', status: 'stopped', folder: '/p/sub', lastActivityAt: '', ...fields });
}

describe('sessions views', () => {
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
    $project.set(null);
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
    clearMocks();
  });

  /** @param {string} cmd */
  const sent = (cmd) => calls.filter((c) => c.cmd === cmd);

  it("stops a running agent, then continues the session in its CLI", async () => {
    $sessions.set([session({ status: 'idle' })]);
    await sessions.continueInTerminal('s1');
    expect(calls.map((c) => c.cmd).filter((c) => c.startsWith('session_'))).to.deep.equal(['session_stop', 'session_open_cli']);
    expect(sent('session_open_cli')[0].args).to.deep.include({ sessionId: 's1' });
    expect(sessionTerminalOf('s1')).to.equal('t-cli');
    expect($terminals.get()['t-cli']).to.include({ status: 'running', sessionId: 's1', cwd: '/p/sub', label: 'Claude Code' });
    expect($sessionViews.get()).to.deep.equal({ s1: 'terminal' });
    expect($cliStarting.get(), 'no longer starting').to.deep.equal([]);
    await sessions.continueInTerminal('s1');
    expect(sent('session_open_cli'), 'a CLI that runs is left alone').to.have.length(1);
  });

  it("opens a terminal in a session's folder and shows the session", async () => {
    // Arrange
    $project.set({ path: '/p', name: 'p', rootId: 'root:/p' });
    $sessions.set([session({ id: 's1' }), session({ id: 's2', folder: '/p/other' })]);
    // Act
    await sessions.openInTerminal('s2');
    // Assert
    expect($activeSessionId.get()).to.equal('s2');
    expect(Object.values($terminals.get()).map((t) => [t.cwd, t.fallback, t.label])).to.deep.equal([['/p/other', '/p', 'other']]);
  });

  it("opens no terminal for an unknown session, or when its project can't be opened", async () => {
    // Arrange
    $sessions.set([session({ id: 's1', projectId: '/gone' })]);
    answer = (cmd) => (cmd === 'open_root' ? new Error('no such folder') : null);
    // Act
    await sessions.openInTerminal('nope');
    await sessions.openInTerminal('s1');
    // Assert
    expect($terminals.get()).to.deep.equal({});
    expect($activeSessionId.get()).to.equal(null);
  });

  it('starts the CLI once however many ask meanwhile', async () => {
    $sessions.set([session()]);
    await Promise.all([sessions.continueInTerminal('s1'), sessions.continueInTerminal('s1')]);
    expect(sent('session_open_cli')).to.have.length(1);
  });

  it("shows why the CLI didn't start in its place", async () => {
    $sessions.set([session()]);
    answer = (cmd) => (cmd === 'session_open_cli' ? new Error('codex: not found') : null);
    await sessions.continueInTerminal('s1');
    const id = /** @type {string} */ (sessionTerminalOf('s1'));
    expect($terminals.get()[id]).to.include({ status: 'failed' });
    expect($terminals.get()[id].error).to.equal("Couldn't start Claude Code: codex: not found");
    expect($terminals.get()[id].label).to.equal('Claude Code');
    expect($cliStarting.get(), 'no longer starting').to.deep.equal([]);
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null);
    await sessions.restartCli('s1');
    expect(sessionTerminalOf('s1'), 'Restart replaces the failed one').to.equal('t-cli');
    expect($terminals.get()[id], 'the failed entry is gone').to.equal(undefined);
  });

  it('asks the backend whether a CLI is busy only when it has one, and says not busy when it cannot tell', async () => {
    expect(await sessions.cliBusy('s1')).to.equal(false);
    expect(calls, 'no CLI: no question').to.deep.equal([]);
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    answer = (cmd) => (cmd === 'session_cli_busy' ? true : null);
    expect(await sessions.cliBusy('s1')).to.equal(true);
    answer = (cmd) => (cmd === 'session_cli_busy' ? new Error('gone') : null);
    expect(await sessions.cliBusy('s1')).to.equal(false);
  });

  it('closes the CLI and resumes the agent to continue in chat', async () => {
    $sessions.set([session()]);
    await sessions.continueInTerminal('s1');
    calls = [];
    await sessions.continueInChat('s1');
    expect(calls.map((c) => c.cmd).filter((c) => c.startsWith('session_'))).to.deep.equal(['session_close_cli', 'session_resume']);
    expect(sessionTerminalOf('s1')).to.equal(null);
    expect($sessionViews.get()).to.deep.equal({});
  });

  it('closes the terminal of a CLI that exited when continuing in chat', async () => {
    $sessions.set([session()]);
    await sessions.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    calls = [];
    await sessions.continueInChat('s1');
    expect(sent('terminal_close').map((c) => c.args)).to.deep.equal([{ ids: ['t-cli'] }]);
    expect(sent('session_close_cli'), 'nothing to stop: it exited by itself').to.have.length(0);
    expect(sessionTerminalOf('s1')).to.equal(null);
  });

  it('closes the terminal of a removed session whose CLI exited', async () => {
    $sessions.set([session()]);
    await sessions.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    await sessions.remove('s1');
    expect(sent('terminal_close').map((c) => c.args)).to.deep.equal([{ ids: ['t-cli'] }]);
  });

  it("closes a workspace's root before removing its last chat, whose workspace goes with it", async () => {
    // Arrange: the backend closes the root only when the test says so
    /** @type {() => void} */
    let closeDone = () => {};
    answer = (cmd) => (cmd === 'close_root' ? new Promise((resolve) => (closeDone = () => resolve(null))) : null);
    projects.showRoot('/wt/one', 'r-w');
    $sessions.set([
      session({ id: 'a', mode: 'worktree', workspaceId: 'w1', folder: '/wt/one' }),
      session({ id: 'b', mode: 'worktree', workspaceId: 'w1', folder: '/wt/one' }),
    ]);

    // Act
    await sessions.remove('a');
    const afterFirst = sent('close_root').length;
    const removing = sessions.remove('b');
    await new Promise((r) => setTimeout(r, 20));
    const beforeClosed = sent('session_remove').length;
    closeDone();
    await removing;

    // Assert
    expect(afterFirst, 'another chat still runs there').to.equal(0);
    expect(sent('close_root').map((c) => c.args)).to.deep.equal([{ rootId: 'r-w' }]);
    expect(beforeClosed, 'the folder is removed only once nothing watches it').to.equal(1);
    expect(sent('session_remove')).to.have.length(2);
  });

  it('starts an exited CLI again on Restart', async () => {
    $sessions.set([session()]);
    await sessions.continueInTerminal('s1');
    $terminals.set({ ...$terminals.get(), 't-cli': { ...$terminals.get()['t-cli'], status: 'exited', exit: { code: 0, signal: null } } });
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli-2' } : null);
    await sessions.restartCli('s1');
    expect(sessionTerminalOf('s1')).to.equal('t-cli-2');
    expect($terminals.get()['t-cli']).to.equal(undefined);
  });
});

describe('sessions keeps the active session in its view', () => {
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
      agents: [/** @type {import('../../agents/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })],
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
    const shown = sessions.show('s1');
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
    const shown = sessions.show('s1');
    expect($activeShownView.get()).to.equal('chat');
    await shown;
    expect(sent(), 'its turn left alone').not.to.include('session_stop');
  });

  it("opens the CLI of a shown session whose agent's sessions open in the terminal", async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    expect($activeShownView.get()).to.equal('chat');
    setAgentView('claude', 'terminal');
    await sessions.reconcile();
    expect(sent()).to.deep.equal(['session_open_cli']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it('leaves a running turn alone, and opens the CLI once it ends', async () => {
    $sessions.set([session({ status: 'working' })]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessions.reconcile();
    expect(sent(), 'nothing stopped').to.deep.equal([]);
    expect($activeShownView.get()).to.equal('chat');

    $sessions.set([session({ status: 'idle' })]);
    await sessions.reconcile();
    expect(sent()).to.deep.equal(['session_stop', 'session_open_cli']);
  });

  it('closes an idle CLI when the agent\'s sessions go back to chat, and resumes the agent with its history', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessions.reconcile();
    calls = [];
    setAgentView('claude', 'chat');
    await sessions.reconcile();
    expect(sent()).to.deep.equal(['session_cli_busy', 'session_close_cli', 'session_resume']);
    expect($activeShownView.get()).to.equal('chat');
    expect($historyResets.get()).to.deep.equal(['s1']);
  });

  it('keeps a busy CLI when the agent\'s sessions go back to chat', async () => {
    $sessions.set([session()]);
    $activeSessionId.set('s1');
    setAgentView('claude', 'terminal');
    await sessions.reconcile();
    busy = true;
    calls = [];
    setAgentView('claude', 'chat');
    await sessions.reconcile();
    expect(sent()).to.deep.equal(['session_cli_busy']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it("creates a draft's chat in its workspace: Main or a stored one", async () => {
    /** @type {[string, unknown, string][]} */
    const cases = [
      ['main', { kind: 'main' }, 'local'],
      ['w1', { kind: 'existing', id: 'w1' }, 'worktree'],
    ];
    for (const [workspaceId, workspace, mode] of cases) {
      // Arrange
      calls = [];
      $draftSessions.set({ d1: { projectId: '/p', workspaceId } });
      $activeSessionId.set('d1');
      setAgentView('claude', 'chat');

      // Act
      sessions.start('d1', 'Fix the build');
      await new Promise((r) => setTimeout(r, 0));

      // Assert
      const create = /** @type {Record<string, unknown> | undefined} */ (calls.find((c) => c.cmd === 'session_create')?.args);
      expect(create?.workspace, workspaceId).to.deep.equal(workspace);
      expect($sessions.get().find((s) => s.id === 'd1')?.mode, `${workspaceId}: listed meanwhile`).to.equal(mode);
      $sessions.set([]);
    }
  });

  it("shows a draft's composer even when its agent's sessions open in the terminal", async () => {
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    await sessions.reconcile();
    expect(sent(), 'no CLI before its first message').to.deep.equal([]);
    expect($activeShownView.get()).to.equal('chat');
    expect(sessions.startsInTerminal('d1')).to.equal(true);
  });

  it("starts a draft's CLI with its first message and the draft's choices", async () => {
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    await sessions.startInTerminal('d1', 'Fix the build', 'fix the build please');
    const open = calls.find((c) => c.cmd === 'session_open_cli');
    expect(open?.args).to.deep.include({ sessionId: 'd1' });
    expect(/** @type {{ draft: Record<string, unknown> }} */ (open?.args).draft).to.include({
      projectPath: '/p',
      agentId: 'claude',
      title: 'Fix the build',
      prompt: 'fix the build please',
    });
    expect(/** @type {{ draft: Record<string, unknown> }} */ (open?.args).draft.workspace, 'in Main').to.deep.equal({ kind: 'main' });
    expect($sessions.get().map((s) => s.id), 'listed').to.deep.equal(['d1']);
    expect($activeShownView.get()).to.equal('terminal');
  });

  it("answers whether a draft's CLI started: a refused one is a draft again", async () => {
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    cliFails = new Error('no npx');
    expect(await sessions.startInTerminal('d1', 'T', 'go')).to.equal(false);
    expect($draftSessions.get()).to.have.property('d1');
    cliFails = null;
    expect(await sessions.startInTerminal('d1', 'T', 'go')).to.equal(true);
  });

  it("forgets the read mark of a removed session and of one whose start was refused", async () => {
    const seen = { seen: '2026-10-20T10:00:00.000Z' };
    $sessions.set([session({ id: 's1', status: 'idle' })]);
    $sessionReads.setKey('s1', seen);
    await sessions.remove('s1');
    expect($sessionReads.get().s1, 'removed').to.equal(undefined);

    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    cliFails = new Error('no npx');
    $sessionReads.setKey('d1', seen);
    try {
      expect(await sessions.startInTerminal('d1', 'T', 'go')).to.equal(false);
      expect($sessionReads.get().d1, 'a draft again').to.equal(undefined);
    } finally {
      forgetRead('d1');
    }
  });

  it('does not write the read mark of the shown session while it is being removed', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    $sessions.set([session({ id: 's1', status: 'idle' })]);
    $activeSessionId.set('s1');
    const stop = trackSeen();
    try {
      expect($sessionReads.get().s1, 'seen while shown').to.not.equal(undefined);
      await sessions.remove('s1');
      expect($sessionReads.get().s1, 'forgotten, not rewritten').to.equal(undefined);
    } finally {
      stop();
      Reflect.deleteProperty(document, 'visibilityState');
      Reflect.deleteProperty(document, 'hasFocus');
      forgetRead('s1');
    }
  });

  it("sends a draft's first message to the chat when its agent's CLI can't start a session", async () => {
    $agentList.set({
      ...$agentList.get(),
      agents: [/** @type {import('../../agents/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: false } })],
    });
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
    setAgentView('claude', 'terminal');
    expect(sessions.startsInTerminal('d1')).to.equal(false);
    setAgentView('claude', 'chat');
    expect(sessions.startsInTerminal('d1'), 'its agent opens sessions as chat').to.equal(false);
  });
});
