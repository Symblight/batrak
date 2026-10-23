import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ACK_EVERY, folderLabel, newTerminalFolder, sessionTerminalFolder, terminalController } from './terminals.js';
import { $terminals, forgetTerminal, openLoginTerminal, openTerminal } from '../stores/terminals.js';
import { $editorTabs } from '../stores/editor.js';
import { noteSignIn } from '../stores/agents.js';
import { $workspace } from '../stores/workspace.js';
import { terminalTabId } from '../models/tab-ids.js';

/** @typedef {import('../models/types.js').Session} Session */

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
function session(fields) {
  return /** @type {Session} */ ({ id: 's', projectId: '/p', mode: 'local', folder: '/p', worktreePath: null, ...fields });
}

describe('terminal folders', () => {
  const home = '/Users/me';

  it('starts a new terminal in the active worktree session’s folder, the project as fallback', () => {
    expect(newTerminalFolder({ activeFolder: '/wt/s1/app', project: '/p', home })).to.deep.equal({
      cwd: '/wt/s1/app',
      fallback: '/p',
    });
  });

  it('starts a new terminal in the project for a draft or a local session', () => {
    expect(newTerminalFolder({ activeFolder: '/p', project: '/p', home })).to.deep.equal({ cwd: '/p', fallback: '/p' });
    expect(newTerminalFolder({ activeFolder: null, project: '/p', home })).to.deep.equal({ cwd: '/p', fallback: '/p' });
  });

  it('starts a new terminal at home with no project', () => {
    expect(newTerminalFolder({ activeFolder: null, project: null, home })).to.deep.equal({ cwd: home, fallback: null });
  });

  it('starts a session’s terminal in that session’s folder', () => {
    const wt = session({ mode: 'worktree', folder: '/wt/s1/app', worktreePath: '/wt/s1' });
    expect(sessionTerminalFolder(wt)).to.deep.equal({ cwd: '/wt/s1/app', fallback: '/p' });
    expect(sessionTerminalFolder(session({}))).to.deep.equal({ cwd: '/p', fallback: '/p' });
  });

  it('names a folder after itself, or a worktree’s after the worktree', () => {
    const sessions = [session({ mode: 'worktree', folder: '/wt/brama-1a2b/app', worktreePath: '/wt/brama-1a2b' })];
    expect(folderLabel('/home/me/app', sessions)).to.equal('app');
    expect(folderLabel('/wt/brama-1a2b/app', sessions)).to.equal('brama-1a2b');
    expect(folderLabel('/wt/brama-1a2b', sessions)).to.equal('brama-1a2b');
    expect(folderLabel('/wt/brama-1a2bc', sessions)).to.equal('brama-1a2bc', 'not a folder in it');
  });

  it('names a worktree’s folder after the worktree with Windows separators too', () => {
    const sessions = [
      session({ mode: 'worktree', folder: 'C:\\wt\\brama-1a2b\\app', worktreePath: 'C:\\wt\\brama-1a2b' }),
    ];
    expect(folderLabel('C:\\wt\\brama-1a2b\\app', sessions)).to.equal('brama-1a2b');
    expect(folderLabel('C:\\wt\\brama-1a2bc', sessions)).to.equal('brama-1a2bc');
  });
});

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 150 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).to.equal(true);
}

describe('terminalController', () => {
  /** @type {{ cmd: string, args: any, headers?: Record<string, string> }[]} */
  let calls;
  /** @type {((buffer: ArrayBuffer) => void) | null} The backend's side of the output channel. */
  let send;
  /** @type {(() => void) | null} */
  let release;

  beforeEach(() => {
    calls = [];
    send = null;
    release = null;
    mockIPC(async (cmd, args) => {
      calls.push({ cmd, args, headers: headers.shift() });
      if (cmd === 'terminal_open') {
        await new Promise((resolve) => (release = () => resolve(undefined)));
        return { shell: 'zsh', cwd: '/p' };
      }
      if (cmd === 'terminal_attach') {
        const output = /** @type {{ output: { onmessage: (b: ArrayBuffer) => void } }} */ (args).output;
        send = (buffer) => output.onmessage(buffer);
      }
      return null;
    });
    // `mockIPC` leaves out the options, where a raw write's terminal id goes.
    /** @type {(Record<string, string> | undefined)[]} */
    const headers = [];
    const internals = /** @type {{ invoke: (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> }} */ (
      /** @type {{ __TAURI_INTERNALS__: unknown }} */ (/** @type {unknown} */ (window)).__TAURI_INTERNALS__
    );
    const invoke = internals.invoke;
    internals.invoke = (cmd, args, options) => {
      headers.push(options?.headers);
      return invoke(cmd, args, options);
    };
  });

  afterEach(() => {
    for (const id of Object.keys($terminals.get())) forgetTerminal(id);
    clearMocks();
  });

  /** A view's sink that keeps each output's `done`. */
  function view() {
    /** @type {(() => void)[]} */
    const pending = [];
    /** @type {import('../models/types.js').TerminalSink} */
    const sink = { output: (_bytes, done) => pending.push(done), reset: () => {}, exit: () => {} };
    return { sink, pending };
  }

  it("closes a login's tab when its sign-in is cancelled", async () => {
    terminalController.start();
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
    openLoginTerminal(terminal, '/p');
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'waiting', message: null, terminal });
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'cancelled', message: null, terminal });
    expect($editorTabs.get().paths).to.not.include(terminalTabId('sign-in-1'));
    expect($terminals.get()['sign-in-1']).to.equal(undefined);
    await until(() => calls.some((c) => c.cmd === 'terminal_close'));
    $workspace.set(null);
  });

  it('starts a shell once when its view connects twice while it starts', async () => {
    const id = openTerminal('/p', '/p', 'p');
    terminalController.connect(id, { cols: 80, rows: 24 }, view().sink).dispose();
    terminalController.connect(id, { cols: 80, rows: 24 }, view().sink);
    await until(() => release !== null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    await until(() => calls.some((c) => c.cmd === 'terminal_attach'));
    expect(calls.filter((c) => c.cmd === 'terminal_open')).to.have.length(1);
  });

  it('sends typed text and raw bytes in order, as bytes', async () => {
    const id = openTerminal('/p', '/p', 'p');
    const link = terminalController.connect(id, { cols: 80, rows: 24 }, view().sink);
    link.write('é');
    link.write(new Uint8Array([0x1b, 0xc8]));
    await until(() => release !== null);
    release?.();
    await until(() => calls.some((c) => c.cmd === 'terminal_write'));
    const write = /** @type {{ args: Uint8Array, headers?: Record<string, string> }} */ (
      calls.find((c) => c.cmd === 'terminal_write')
    );
    expect([...write.args]).to.deep.equal([0xc3, 0xa9, 0x1b, 0xc8]);
    expect(write.headers).to.deep.equal({ 'terminal-id': id });
  });

  it('acknowledges output once drawn, and what a view leaves undrawn when it goes', async () => {
    const id = openTerminal('/p', '/p', 'p');
    const { sink, pending } = view();
    const link = terminalController.connect(id, { cols: 80, rows: 24 }, sink);
    await until(() => release !== null);
    release?.();
    await until(() => send !== null);
    send?.(new Uint8Array(ACK_EVERY - 1).buffer);
    send?.(new Uint8Array(10).buffer);
    send?.(new Uint8Array(20).buffer);
    const acks = () => calls.filter((c) => c.cmd === 'terminal_ack').map((c) => c.args.bytes);
    pending[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acks()).to.deep.equal([], 'batched');
    pending[1]();
    await until(() => acks().length === 1);
    expect(acks()).to.deep.equal([ACK_EVERY + 9]);
    link.dispose();
    await until(() => acks().length === 2);
    expect(acks()[1]).to.equal(20);
  });
});
