import { tabs } from '../../../hooks/tabs/tabs.js';
import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  ACK_EVERY,
  folderLabel,
  newTerminalFolder,
  projectTerminalFolder,
  sessionTerminalFolder,
  terminalController,
} from '../terminals.js';
import { $terminals, addSessionTerminal, forgetTerminal, openLoginTerminal, openTerminal, terminalFailed } from '../../../stores/terminals/terminals.js';
import { $editorTabs } from '../../../stores/editor/editor.js';
import { noteSignIn } from '../../../stores/agents/agents.js';
import { $activeSessionId, $sessions } from '../../../stores/sessions/sessions.js';
import { $workspace } from '../../../stores/workspace/workspace.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
function session(fields) {
  return /** @type {Session} */ ({ id: 's', projectId: '/p', mode: 'local', folder: '/p', worktreePath: null, ...fields });
}

describe('terminal folders', () => {
  const home = '/Users/me';
  const wt = session({ mode: 'worktree', folder: '/wt/s1/app', worktreePath: '/wt/s1' });

  it('picks where each kind of terminal starts: the session’s folder, the project, or home', () => {
    const cases = [
      ['new, in a worktree session', newTerminalFolder({ activeFolder: '/wt/s1/app', project: '/p', home }), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['new, in a local session', newTerminalFolder({ activeFolder: '/p', project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, in a draft', newTerminalFolder({ activeFolder: null, project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['new, with no project', newTerminalFolder({ activeFolder: null, project: null, home }), { cwd: home, fallback: null }],
      ['project', projectTerminalFolder({ project: '/p', home }), { cwd: '/p', fallback: '/p' }],
      ['project, with no project', projectTerminalFolder({ project: null, home }), { cwd: home, fallback: null }],
      ['a worktree session’s', sessionTerminalFolder(wt), { cwd: '/wt/s1/app', fallback: '/p' }],
      ['a local session’s', sessionTerminalFolder(session({})), { cwd: '/p', fallback: '/p' }],
    ];
    for (const [why, folder, expected] of cases) expect(folder, String(why)).to.deep.equal(expected);
  });

  it('names a folder after itself, or a worktree’s after the worktree (either separator)', () => {
    const posix = [session({ mode: 'worktree', folder: '/wt/brama-1a2b/app', worktreePath: '/wt/brama-1a2b' })];
    const windows = [session({ mode: 'worktree', folder: 'C:\\wt\\brama-1a2b\\app', worktreePath: 'C:\\wt\\brama-1a2b' })];
    const cases = [
      ['/home/me/app', posix, 'app'],
      ['/wt/brama-1a2b/app', posix, 'brama-1a2b'],
      ['/wt/brama-1a2b', posix, 'brama-1a2b'],
      ['/wt/brama-1a2bc', posix, 'brama-1a2bc'],
      ['C:\\wt\\brama-1a2b\\app', windows, 'brama-1a2b'],
      ['C:\\wt\\brama-1a2bc', windows, 'brama-1a2bc'],
    ];
    for (const [folder, sessions, label] of cases) {
      expect(folderLabel(/** @type {string} */ (folder), /** @type {Session[]} */ (sessions)), String(folder)).to.equal(label);
    }
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
    /** @type {import('../../../models/types/types.js').TerminalSink} */
    const sink = { output: (_bytes, done) => pending.push(done), reset: () => {}, exit: () => {} };
    return { sink, pending };
  }

  it("doesn't attach a session's CLI that didn't start, and keeps why", async () => {
    terminalController.start();
    addSessionTerminal('cli:s1', 's1', '/p', 'Claude Code');
    terminalFailed('cli:s1', "Couldn't start Claude Code: held by another window");
    const link = terminalController.connect('cli:s1', { cols: 80, rows: 24 }, view().sink);
    // Attaches run in connect order, so once this shell's has, the CLI's would have.
    const id = openTerminal('/p', '/p', 'p');
    const other = terminalController.connect(id, { cols: 80, rows: 24 }, view().sink);
    await until(() => release !== null);
    release?.();
    await until(() => calls.some((c) => c.cmd === 'terminal_attach'));
    expect(calls.filter((c) => c.cmd === 'terminal_attach')).to.have.length(1);
    expect($terminals.get()['cli:s1'].error).to.equal("Couldn't start Claude Code: held by another window");
    link.dispose();
    other.dispose();
  });

  it("closes a login's tab when its sign-in is cancelled", async () => {
    terminalController.start();
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
    openLoginTerminal(terminal, '/p');
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'waiting', message: null, terminal });
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'cancelled', message: null, terminal });
    expect($editorTabs.get().paths).to.not.include(tabs.terminalId('sign-in-1'));
    expect($terminals.get()['sign-in-1']).to.equal(undefined);
    await until(() => calls.some((c) => c.cmd === 'terminal_close'));
    $workspace.set(null);
  });

  it('starts a shell once when its view connects twice while it starts', async () => {
    const id = openTerminal('/p', '/p', 'p');
    terminalController.connect(id, { cols: 80, rows: 24 }, view().sink).dispose();
    terminalController.connect(id, { cols: 80, rows: 24 }, view().sink);
    await until(() => release !== null);
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
    pending[1]();
    await until(() => acks().length >= 1);
    expect(acks()).to.deep.equal([ACK_EVERY + 9], 'batched into one');
    link.dispose();
    await until(() => acks().length === 2);
    expect(acks()[1]).to.equal(20);
  });

  it('opens a project terminal in the workspace root, ignoring any active worktree folder', async () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $sessions.set([session({ id: 's1', mode: 'worktree', folder: '/wt/s1/app', worktreePath: '/wt/s1' })]);
    $activeSessionId.set('s1');
    await terminalController.projectTerminal();
    const terminals = Object.values($terminals.get());
    expect(terminals.map((t) => [t.cwd, t.fallback, t.label])).to.deep.equal([['/p', '/p', 'p']]);
    $workspace.set(null);
    $sessions.set([]);
    $activeSessionId.set(null);
  });
});
