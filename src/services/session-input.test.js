import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { sessionInput } from './session-input.js';
import { $agentList } from '../stores/agents.js';
import { $sessionNotices } from '../stores/session-runtime.js';
import { $agentViews, setAgentView } from '../stores/session-views.js';
import { $activeSessionId, $draftSessions, $sessions } from '../stores/sessions.js';
import { $terminals } from '../stores/terminals.js';

/** @typedef {import('../models/types.js').SessionInput} SessionInput */

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
      agents: [/** @type {import('../models/types.js').AgentSummary} */ ({ id: 'claude', name: 'Claude Code', enabled: true, terminal: { resume: true, new: true } })],
    });
    $draftSessions.set({ d1: '/p' });
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

  it("refuses attachments, which the CLI can't take yet, and starts nothing", async () => {
    setAgentView('claude', 'terminal');
    const input = { parts: [{ kind: /** @type {const} */ ('text'), text: 'look' }], files: [new File(['x'], 'shot.png')] };
    const outcome = await sessionInput.startTerminal('d1', input, 'look');
    expect(outcome.taken).to.equal(false);
    expect(draftSent()).to.equal(undefined);
    expect($sessionNotices.get().d1).to.include({ kind: 'error' });
    expect($sessionNotices.get().d1?.message).to.contain('shot.png');
  });

  it('answers not taken when the CLI fails to start', async () => {
    setAgentView('claude', 'terminal');
    cliFails = new Error('no npx');
    const input = { parts: [{ kind: /** @type {const} */ ('text'), text: 'go' }], files: [] };
    expect((await sessionInput.startTerminal('d1', input, 'go')).taken).to.equal(false);
  });
});
