import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cliBusy, closeCli, openCli, restartCli } from '../cli.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { $cliStarting, $terminals, addSessionTerminal, sessionTerminalOf, terminalExited } from '../../../stores/terminals/terminals.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */

/** @param {Partial<Session>} [fields] */
const session = (fields = {}) => /** @type {Session} */ ({ id: 's1', projectId: '/p', agentName: 'Claude Code', status: 'stopped', folder: '/p/sub', ...fields });

describe('session CLI', () => {
  /** @type {string[]} */
  let cmds;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    cmds = [];
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null);
    mockIPC((cmd) => {
      cmds.push(cmd);
      const value = answer(cmd);
      if (value instanceof Error) throw value;
      return value;
    });
    $sessions.set([session()]);
  });

  afterEach(() => {
    $sessions.set([]);
    $terminals.set({});
    $cliStarting.set([]);
    clearMocks();
  });

  it('starts a session’s CLI once however many ask meanwhile, in its folder, stopping a running agent first', async () => {
    $sessions.set([session({ status: 'idle' })]);
    await Promise.all([openCli('s1'), openCli('s1')]);
    expect(cmds.filter((c) => c.startsWith('session_'))).to.deep.equal(['session_stop', 'session_open_cli']);
    expect(sessionTerminalOf('s1')).to.equal('t-cli');
    expect($terminals.get()['t-cli']).to.include({ status: 'running', cwd: '/p/sub', label: 'Claude Code' });
    expect($cliStarting.get(), 'no longer starting').to.deep.equal([]);
    await openCli('s1');
    expect(cmds.filter((c) => c === 'session_open_cli'), 'one that runs is left alone').to.have.length(1);
  });

  it('shows a CLI that failed to start in its place, with why, ready for Restart', async () => {
    answer = (cmd) => (cmd === 'session_open_cli' ? new Error('no such binary') : null);
    await openCli('s1');
    const terminal = $terminals.get()['cli:s1'];
    expect(terminal).to.include({ status: 'failed', label: 'Claude Code' });
    expect(terminal.error).to.equal("Couldn't start Claude Code: no such binary");
    answer = (cmd) => (cmd === 'session_open_cli' ? { terminalId: 't-cli' } : null);
    await restartCli('s1');
    expect(sessionTerminalOf('s1'), 'Restart replaces the failed one').to.equal('t-cli');
    expect($terminals.get()['cli:s1']).to.equal(undefined);
  });

  it('closes a running CLI through the backend and keeps nothing of one that exited by itself', async () => {
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    await closeCli('s1');
    expect(cmds).to.deep.equal(['session_close_cli']);
    expect(sessionTerminalOf('s1')).to.equal(null);

    cmds.length = 0;
    addSessionTerminal('t-gone', 's1', '/p', 'Claude Code');
    terminalExited('t-gone', { code: 0, signal: null });
    await closeCli('s1');
    expect(cmds, 'nothing to stop: only its terminal is closed').to.not.include('session_close_cli');
    expect(sessionTerminalOf('s1')).to.equal(null);
    await closeCli('s1');
  });

  it('asks the backend whether a CLI is busy only when it has one, and says not busy when it cannot tell', async () => {
    expect(await cliBusy('s1')).to.equal(false);
    expect(cmds, 'no CLI: no question').to.deep.equal([]);
    addSessionTerminal('t-cli', 's1', '/p', 'Claude Code');
    answer = (cmd) => (cmd === 'session_cli_busy' ? true : null);
    expect(await cliBusy('s1')).to.equal(true);
    answer = (cmd) => (cmd === 'session_cli_busy' ? new Error('gone') : null);
    expect(await cliBusy('s1')).to.equal(false);
  });
});
