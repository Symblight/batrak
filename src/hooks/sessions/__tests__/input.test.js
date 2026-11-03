import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { input as sessionInput } from '../input.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { $sessionNotices, setSessionNotice } from '../../../stores/session-runtime/session-runtime.js';
import { $agentViews, setAgentView } from '../../../stores/session-views/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $terminals } from '../../../stores/terminals/terminals.js';
import { setRunTarget } from '../../../stores/composer/composer.js';
import { $gitRepo, NO_REPO } from '../../../stores/git/git.js';
import { $notices } from '../../../stores/notices/notices.js';
import { setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';

/** @typedef {import('../../chat/types.js').SessionInput} SessionInput */

describe('sessionInput', () => {
  /** @type {{ cmd: string, args: unknown }[]} */
  let calls = [];
  /** @type {Error | null} */
  let cliFails = null;

  beforeEach(() => {
    calls = [];
    cliFails = null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'session_open_cli' && cliFails) throw cliFails;
      return cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null;
    });
    $agentList.set({
      ...$agentList.get(),
      defaultAgent: 'claude',
      agents: [/** @type {import('../../agents/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })],
    });
    $draftSessions.set({ d1: { projectId: '/p', workspaceId: 'main' } });
    $activeSessionId.set('d1');
  });

  afterEach(() => {
    $agentViews.set({});
    $terminals.set({});
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $sessionNotices.set({});
    $notices.set([]);
    $gitRepo.set(NO_REPO);
    setWorkspaces([]);
    setActiveWorkspace('/p', 'main');
    $agentList.set({ ...$agentList.get(), agents: [], defaultAgent: null });
    clearMocks();
  });

  /** @returns {Record<string, unknown> | undefined} The draft `session_open_cli` was sent. */
  const draftSent = () =>
    /** @type {{ draft: Record<string, unknown> } | undefined} */ (calls.find((c) => c.cmd === 'session_open_cli')?.args)?.draft;

  it("says where a draft's first send goes: its agent's CLI or the chat", () => {
    expect(sessionInput.draftTarget('d1')).to.equal('chat-draft');
    setAgentView('claude', 'terminal');
    expect(sessionInput.draftTarget('d1')).to.equal('terminal-draft');
    $draftSessions.set({});
    expect(sessionInput.draftTarget('d1'), 'not a draft').to.equal(null);
  });

  it("starts the CLI with the chips' whole paths, not their labels", async () => {
    setAgentView('claude', 'terminal');
    /** @type {SessionInput} */
    const input = {
      parts: [
        { kind: 'ref', path: 'src/stores/editor.js', folder: false },
        { kind: 'text', text: ' fix the tabs' },
      ],
      files: [],
    };
    expect(await sessionInput.startTerminal('d1', input, 'editor.js fix the tabs')).to.deep.equal({ taken: true });
    expect(draftSent()).to.include({ prompt: '@src/stores/editor.js fix the tabs', title: 'editor.js fix the tabs' });
  });

  it("writes the CLI's refs relative to the project only when the chat runs there (Local), else whole", async () => {
    /** @type {[string, import('../../composer/types.js').RunTarget | null, string][]} */
    const cases = [
      // [the draft's workspace, picked place, the prompt sent]
      ['main', null, '@src/a.js fix'],
      ['main', { kind: 'worktree', base: 'dev' }, '@/p/src/a.js fix'],
      ['w1', null, '@/p/src/a.js fix'],
      ['w1', { kind: 'local' }, '@src/a.js fix'],
    ];
    setAgentView('claude', 'terminal');
    $gitRepo.set({ repo: /** @type {import('../../git/types.js').GitRepoState} */ ({ sha: 'abc' }), error: null });
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'workspace_create') return { id: 'w2', projectPath: '/p', name: 'Workspace 2', folder: '/wt/two' };
      return cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null;
    });
    /** @type {SessionInput} */
    const input = { parts: [{ kind: 'ref', path: '/p/src/a.js', folder: false }, { kind: 'text', text: ' fix' }], files: [] };
    for (const [workspaceId, target, prompt] of cases) {
      // Arrange
      calls = [];
      const id = crypto.randomUUID();
      $draftSessions.set({ [id]: { projectId: '/p', workspaceId } });
      if (target) setRunTarget(id, target);

      // Act
      await sessionInput.startTerminal(id, input, 'fix');

      // Assert
      expect(draftSent()?.prompt, `${workspaceId}, ${target?.kind ?? 'default'}`).to.equal(prompt);
      $sessions.set([]);
    }
  });

  it("says a New worktree's refused workspace only in its snackbar, not again above the composer", async () => {
    // Arrange
    setAgentView('claude', 'terminal');
    $gitRepo.set({ repo: /** @type {import('../../git/types.js').GitRepoState} */ ({ sha: 'abc' }), error: null });
    mockIPC((cmd) => {
      if (cmd === 'workspace_create') throw new Error('no commit yet');
      return null;
    });
    setRunTarget('d1', { kind: 'worktree', base: 'dev' });

    // Act
    const outcome = await sessionInput.startTerminal('d1', { parts: [{ kind: 'text', text: 'go' }], files: [] }, 'go');

    // Assert
    expect(outcome.taken).to.equal(false);
    expect($notices.get().map((n) => n.message)).to.deep.equal(['Creating the workspace failed: no commit yet']);
    expect($sessionNotices.get().d1 ?? null, 'no notice above the composer').to.equal(null);
  });

  it("refuses attachments, which neither view can send yet, naming them", () => {
    $sessions.set([/** @type {import('../types.js').Session} */ ({ id: 's1', agentId: 'claude', agentName: 'Claude Code' })]);
    expect(sessionInput.refuseFiles('s1', [])).to.equal(null);
    const reason = sessionInput.refuseFiles('s1', [new File(['x'], 'shot.png'), new File(['y'], 'log.txt')]);
    expect(reason).to.contain('shot.png, log.txt');
    expect($sessionNotices.get().s1).to.deep.equal({ kind: 'info', message: reason });
    setSessionNotice('s1', { kind: 'outdated', message: 'agents.json changed' });
    sessionInput.refuseFiles('s1', [new File(['x'], 'a.png')]);
    sessionInput.refuseFiles('s1', [new File(['x'], 'b.png')]);
    expect($sessionNotices.get().s1?.under, 'a second refusal covers the same notice').to.deep.equal({ kind: 'outdated', message: 'agents.json changed' });
  });

  it('answers not taken when the CLI fails to start', async () => {
    setAgentView('claude', 'terminal');
    cliFails = new Error('no npx');
    const input = { parts: [{ kind: /** @type {const} */ ('text'), text: 'go' }], files: [] };
    expect((await sessionInput.startTerminal('d1', input, 'go')).taken).to.equal(false);
  });
});
