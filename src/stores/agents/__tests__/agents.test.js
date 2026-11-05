import { expect } from '@esm-bundle/chai';
import { $agentsPending, $signIns, noteSignIn, signInOf, signInsOf, whileUpdating } from '../agents.js';

describe('agents', () => {
  it('shows agents as updating while their call runs, a failed one too', async () => {
    /** @type {(value: string) => void} */
    let finish = () => {};
    const first = whileUpdating(['a'], () => new Promise((resolve) => (finish = resolve)));
    const second = whileUpdating(['a', 'b'], () => Promise.reject(new Error('npm')));
    await second.catch(() => {});
    expect($agentsPending.get().updating, 'the first call still runs').to.deep.equal(['a']);
    finish('done');
    expect(await first).to.equal('done');
    expect($agentsPending.get().updating).to.deep.equal([]);
  });

  it("keeps a project's running or failed sign-ins until one ends", () => {
    noteSignIn({ projectPath: '/p', agentId: 'codex', state: 'waiting', message: null, terminal: null });
    expect(signInOf('/p', 'codex')).to.deep.equal({ state: 'waiting', message: null, terminal: null });
    expect(signInOf('/q', 'codex'), "another project's agent").to.equal(null);
    noteSignIn({ projectPath: '/p', agentId: 'codex', state: 'failed', message: 'login failed', terminal: null });
    expect(signInOf('/p', 'codex')).to.deep.equal({ state: 'failed', message: 'login failed', terminal: null });
    noteSignIn({ projectPath: '/p', agentId: 'codex', state: 'done', message: 'Signed in to Codex', terminal: null });
    expect(signInOf('/p', 'codex')).to.equal(null);
    const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
    noteSignIn({ projectPath: null, agentId: 'codex', state: 'waiting', message: null, terminal });
    expect(signInOf(null, 'codex')?.terminal, "a login's terminal").to.deep.equal(terminal);
    noteSignIn({ projectPath: null, agentId: 'codex', state: 'cancelled', message: null, terminal });
    expect($signIns.get()).to.deep.equal({});
  });

  it("gives one project's sign-ins by agent", () => {
    noteSignIn({ projectPath: '/p', agentId: 'codex', state: 'failed', message: 'no', terminal: null });
    noteSignIn({ projectPath: '/p', agentId: 'zed', state: 'waiting', message: null, terminal: null });
    noteSignIn({ projectPath: null, agentId: 'gemini', state: 'waiting', message: null, terminal: null });
    expect(Object.keys(signInsOf($signIns.get(), '/p')).sort()).to.deep.equal(['codex', 'zed']);
    expect(signInsOf($signIns.get(), null)).to.deep.equal({ gemini: { state: 'waiting', message: null, terminal: null } });
    $signIns.set({});
  });
});
