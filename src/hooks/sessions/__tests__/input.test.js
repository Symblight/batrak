import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { input as sessionInput } from '../input.js';
import { $agentList } from '../../../stores/agents/agents.js';
import { $sessionNotices, setSessionNotice } from '../../../stores/session-runtime/session-runtime.js';
import { $agentViews, setAgentView } from '../../../stores/session-views/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $terminals } from '../../../stores/terminals/terminals.js';

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
