import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect } from '@esm-bundle/chai';
import { noteSignIn } from '../../../stores/agents/agents.js';
import { $activeSessionId, $sessions } from '../../../stores/sessions/sessions.js';
import {
  $folderTerminalPanels,
  $folderTerminalTabs,
  $terminalFocus,
  $terminalPanel,
  $terminalTabs,
  $terminals,
  addSessionTerminal,
  closeTerminalTab,
  forgetTerminal,
  openLoginTerminal,
  openTerminal,
  removeProjectTerminals,
  terminalFailed,
} from '../../../stores/terminals/terminals.js';
import { $project } from '../../../stores/project/project.js';
import { tabs } from '../../tabs/tabs.js';
import { MAIN, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';

/** @typedef {import('../../sessions/types.js').Session} Session */
/** @typedef {import('../types.js').TerminalSink} TerminalSink */

/** @type {{ cmd: string, args: any, headers?: Record<string, string> }[]} */
let calls;
/** @type {((buffer: ArrayBuffer) => void) | null} The backend's side of the output channel. */
let send;
/** @type {((exit: { kind: 'exit', code: number | null, signal: string | null }) => void) | null} The backend's side of the events channel. */
let exitWith;
/** @type {(() => void) | null} Lets every held `terminal_open` answer. */
let release;
/** @type {(() => void)[]} */
let held;
/** @type {Promise<void> | null} When set, `close_window_terminals` answers once it settles. */
let closeGate;
/** @type {(() => void) | null} */
let stop = null;
let counter = 0;

/**
 * A fresh copy of the hook (its state is module-level), started.
 * @returns {Promise<typeof import('../terminals.js')>}
 */
async function started() {
  const module = await import(`../terminals.js?fresh=${++counter}`);
  stop = module.terminals.start();
  return module;
}

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 150 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).to.equal(true);
}

const sent = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd);

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
function session(fields) {
  return /** @type {Session} */ ({ id: 's', projectId: '/p', folder: '/p', ...fields });
}

/** A view's sink that keeps each output's `done`, and what it was told. */
function view() {
  /** @type {(() => void)[]} */
  const pending = [];
  let resets = 0;
  /** @type {TerminalSink} */
  const sink = { output: (_bytes, done) => pending.push(done), reset: () => resets++, exit: () => {} };
  return { sink, pending, resets: () => resets };
}

describe('terminals', () => {
  beforeEach(() => {
    calls = [];
    send = null;
    exitWith = null;
    release = null;
    held = [];
    closeGate = null;
    mockIPC(async (cmd, args) => {
      calls.push({ cmd, args, headers: headers.shift() });
      if (cmd === 'close_window_terminals') await closeGate;
      if (cmd === 'terminal_open') {
        await new Promise((resolve) => {
          held.push(() => resolve(undefined));
          release = () => held.splice(0).forEach((answer) => answer());
        });
        return { shell: 'zsh', cwd: '/p' };
      }
      if (cmd === 'terminal_attach') {
        const { output, events } = /** @type {{ output: { onmessage: (b: ArrayBuffer) => void }, events: { onmessage: typeof exitWith } }} */ (args);
        send = (buffer) => output.onmessage(buffer);
        exitWith = events.onmessage;
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
    stop?.();
    stop = null;
    for (const id of Object.keys($terminals.get())) forgetTerminal(id);
    $folderTerminalTabs.set({});
    $folderTerminalPanels.set({});
    $terminalFocus.set(null);
    clearMocks();
    setActiveWorkspace('/p', MAIN);
    setWorkspaces([]);
    $project.set(null);
    $sessions.set([]);
    $activeSessionId.set(null);
  });

  it("opens the rail's first terminal, New Terminal and a session's Open in → Terminal in the shown workspace's folder and panel", async () => {
    // Arrange
    const { terminals } = await started();
    const wt = session({ id: 's1', workspaceId: 'w1', folder: '/wt/s1/app' });
    $project.set({ path: '/p', name: 'p', rootId: null });
    setWorkspaces([/** @type {import('../../workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/s1/app', worktreePath: '/wt/s1' })], '/p');
    setActiveWorkspace('/p', 'w1');
    $sessions.set([wt]);
    // Act
    await terminals.showPanel();
    await terminals.newTerminal();
    terminals.openInSession(wt);
    // Assert
    expect(Object.values($terminals.get()).map((t) => [t.cwd, t.fallback, t.label, t.folder])).to.deep.equal([
      ['/wt/s1/app', '/p', 's1', '/wt/s1/app'],
      ['/wt/s1/app', '/p', 's1', '/wt/s1/app'],
      ['/wt/s1/app', '/p', 's1', '/wt/s1/app'],
    ]);
    expect($terminalPanel.get()).to.deep.equal({ open: true });
  });

  it('closes the previous page load’s shells as soon as it starts, before any view connects', async () => {
    // Act
    await started();
    // Assert
    expect(sent('close_window_terminals')).to.have.length(1);
  });

  it('works with its methods passed on by themselves, and starts a failed shell again on Restart', async () => {
    // Arrange
    const { terminals } = await started();
    const { connect, restart, busy } = terminals;
    const id = openTerminal('/p', '/p', 'p');
    terminalFailed(id, 'no such shell');
    const screen = view();
    // Act
    const link = connect(id, { cols: 80, rows: 24 }, screen.sink);
    await restart(id);
    await until(() => release !== null);
    release?.();
    await until(() => $terminals.get()[id].status === 'running');
    await until(() => sent('terminal_attach').length > 0);
    // Assert
    expect(screen.resets()).to.equal(1);
    expect(await busy([]), 'nothing asked, nothing busy').to.deep.equal([]);
    link.dispose();
  });

  it('starts no shell until the ones a previous page load left are closed', async () => {
    // Arrange
    /** @type {() => void} */
    let closed = () => {};
    closeGate = new Promise((resolve) => (closed = resolve));
    const { terminals } = await started();
    const id = openTerminal('/p', '/p', 'p');
    // Act
    const link = terminals.connect(id, { cols: 80, rows: 24 }, view().sink);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = sent('terminal_open').length;
    closed();
    await until(() => sent('terminal_open').length === 1);
    // Assert
    expect(before, 'held back').to.equal(0);
    expect(calls[0].cmd).to.equal('close_window_terminals');
    link.dispose();
  });

  it("doesn't attach a session's CLI that didn't start, and keeps why", async () => {
    // Arrange
    const { terminals } = await started();
    addSessionTerminal('cli:s1', 's1', '/p', 'Claude Code');
    terminalFailed('cli:s1', "Couldn't start Claude Code: held by another window");
    // Act
    const link = terminals.connect('cli:s1', { cols: 80, rows: 24 }, view().sink);
    // Attaches run in connect order, so once this shell's has, the CLI's would have.
    const id = openTerminal('/p', '/p', 'p');
    const other = terminals.connect(id, { cols: 80, rows: 24 }, view().sink);
    await until(() => release !== null);
    release?.();
    await until(() => sent('terminal_attach').length > 0);
    // Assert
    expect(sent('terminal_attach')).to.have.length(1);
    expect($terminals.get()['cli:s1'].error).to.equal("Couldn't start Claude Code: held by another window");
    link.dispose();
    other.dispose();
  });

  it('starts a shell once when its view connects twice while it starts', async () => {
    // Arrange
    const { terminals } = await started();
    const id = openTerminal('/p', '/p', 'p');
    // Act
    terminals.connect(id, { cols: 80, rows: 24 }, view().sink).dispose();
    terminals.connect(id, { cols: 80, rows: 24 }, view().sink);
    await until(() => release !== null);
    release?.();
    await until(() => sent('terminal_attach').length > 0);
    // Assert
    expect(sent('terminal_open')).to.have.length(1);
  });

  it('sends typed text and raw bytes in order, as bytes', async () => {
    // Arrange
    const { terminals } = await started();
    const id = openTerminal('/p', '/p', 'p');
    const link = terminals.connect(id, { cols: 80, rows: 24 }, view().sink);
    // Act
    link.write('é');
    link.write(new Uint8Array([0x1b, 0xc8]));
    await until(() => release !== null);
    release?.();
    await until(() => sent('terminal_write').length > 0);
    // Assert
    const [write] = sent('terminal_write');
    expect([...write.args]).to.deep.equal([0xc3, 0xa9, 0x1b, 0xc8]);
    expect(write.headers).to.deep.equal({ 'terminal-id': id });
  });

  it('asks the backend to forget a terminal’s kept output when its view clears', async () => {
    // Arrange
    const { terminals } = await started();
    const id = openTerminal('/p', '/p', 'p');
    const link = terminals.connect(id, { cols: 80, rows: 24 }, view().sink);
    // Act
    link.clear();
    await until(() => sent('terminal_clear').length > 0);
    // Assert
    expect(sent('terminal_clear')[0].args).to.deep.equal({ id });
    link.dispose();
  });

  it('acknowledges output once drawn, and what a view leaves undrawn when it goes', async () => {
    // Arrange
    const { terminals, ACK_EVERY } = await started();
    const id = openTerminal('/p', '/p', 'p');
    const { sink, pending } = view();
    const link = terminals.connect(id, { cols: 80, rows: 24 }, sink);
    await until(() => release !== null);
    release?.();
    await until(() => send !== null);
    const acks = () => sent('terminal_ack').map((c) => c.args.bytes);
    // Act
    send?.(new Uint8Array(ACK_EVERY - 1).buffer);
    send?.(new Uint8Array(10).buffer);
    send?.(new Uint8Array(20).buffer);
    pending[0]();
    pending[1]();
    await until(() => acks().length >= 1);
    const batched = acks();
    link.dispose();
    await until(() => acks().length === 2);
    // Assert
    expect(batched, 'batched into one').to.deep.equal([ACK_EVERY + 9]);
    expect(acks()[1]).to.equal(20);
  });

  it('closes the tab of a shell that exits with 0, keeps one that fails with Restart, and starts it afresh', async () => {
    // Arrange
    const { terminals } = await started();
    $project.set({ path: '/p', name: 'p', rootId: null });
    const clean = openTerminal('/p', '/p', 'p');
    const failing = openTerminal('/p', '/p', 'p');
    const screens = { clean: view(), failing: view() };
    // Act
    terminals.connect(clean, { cols: 80, rows: 24 }, screens.clean.sink);
    terminals.connect(failing, { cols: 80, rows: 24 }, screens.failing.sink);
    await until(() => sent('terminal_open').length === 2);
    release?.();
    await until(() => sent('terminal_attach').length === 2);
    const [cleanEvents, failingEvents] = sent('terminal_attach').map((c) => c.args.events.onmessage);
    cleanEvents({ kind: 'exit', code: 0, signal: null });
    failingEvents({ kind: 'exit', code: 1, signal: null });
    await until(() => $terminals.get()[failing].status === 'exited');
    const exited = [$terminalTabs.get().paths.includes(tabs.terminalId(clean)), $terminals.get()[failing].exit];
    const restarted = terminals.restart(failing);
    await until(() => sent('terminal_open').length === 3);
    const restarting = $terminals.get()[failing].status;
    release?.();
    await restarted;
    // Assert
    expect(exited, 'clean exit closes its tab; the other keeps its exit').to.deep.equal([false, { code: 1, signal: null }]);
    expect(screens.failing.resets(), 'the screen is cleared').to.equal(1);
    expect(restarting, 'a fresh shell starts').to.equal('starting');
    expect($terminals.get()[failing].status).to.equal('running');
  });

  it("closes a login's tab when its sign-in is cancelled", async () => {
    // Arrange
    await started();
    $project.set({ path: '/p', name: 'p', rootId: null });
    const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
    openLoginTerminal(terminal, '/p');
    // Act
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'waiting', message: null, terminal });
    noteSignIn({ projectPath: '/p', agentId: 'copilot', state: 'cancelled', message: null, terminal });
    // Assert
    expect($terminalTabs.get().paths).to.not.include(tabs.terminalId('sign-in-1'));
    expect($terminals.get()['sign-in-1']).to.equal(undefined);
    await until(() => sent('terminal_close').length > 0);
    expect(sent('terminal_close')[0].args).to.deep.equal({ ids: ['sign-in-1'] });
  });

  describe('the terminal panel', () => {
    const panelTerminals = () => $terminalTabs.get().paths.map((tab) => /** @type {string} */ (tabs.terminalOf(tab)));

    it('follows the rail: the first click shows the panel with one terminal, later ones add none', async () => {
      // Arrange
      const { terminals } = await started();
      $project.set({ path: '/p', name: 'p', rootId: null });
      // Act
      await terminals.showPanel();
      const [first] = panelTerminals();
      terminals.hidePanel();
      const hidden = [$terminalPanel.get().open, panelTerminals()];
      $terminalFocus.set(null);
      await terminals.showPanel();
      const shownAgain = [$terminalPanel.get().open, panelTerminals()];
      const focusOnShow = $terminalFocus.get();
      $terminalFocus.set(null);
      await terminals.showPanel();
      // Assert
      expect($terminals.get()[first].cwd, 'the project’s folder').to.equal('/p');
      expect(hidden, 'hiding stops no shell and forgets nothing').to.deep.equal([false, [first]]);
      expect(shownAgain, 'the same terminal, as it was').to.deep.equal([true, [first]]);
      expect(focusOnShow, 'shown by the rail: takes the keyboard').to.deep.equal({ terminalId: first });
      expect(panelTerminals(), 'a click while shown adds none').to.deep.equal([first]);
      expect($terminalFocus.get(), 'but focuses the active one').to.deep.equal({ terminalId: first });
      expect(sent('terminal_close')).to.have.length(0);
    });

    it('adds a terminal with +, showing a hidden panel', async () => {
      // Arrange
      const { terminals } = await started();
      $project.set({ path: '/p', name: 'p', rootId: null });
      await terminals.showPanel();
      terminals.hidePanel();
      // Act
      await terminals.newTerminal();
      // Assert
      expect($terminalPanel.get().open).to.equal(true);
      expect(panelTerminals()).to.have.length(2);
    });

    it('hides the panel when its last terminal goes, and closes the shell of each terminal that goes', async () => {
      // Arrange
      await started();
      $project.set({ path: '/p', name: 'p', rootId: null });
      const a = openTerminal('/p', '/p', 'p');
      const b = openTerminal('/p', '/p', 'p');
      // Act
      closeTerminalTab('/p', a);
      const afterFirst = $terminalPanel.get().open;
      closeTerminalTab('/p', b);
      // Assert
      expect(afterFirst).to.equal(true);
      expect($terminalPanel.get().open).to.equal(false);
      await until(() => sent('terminal_close').length === 2);
      expect(sent('terminal_close').flatMap((c) => c.args.ids)).to.deep.equal([a, b]);
    });

    it('closes the shells of a removed project’s panels, its workspaces’ too', async () => {
      // Arrange
      await started();
      $project.set({ path: '/p', name: 'p', rootId: null });
      setWorkspaces([/** @type {import('../../workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/task' })], '/p');
      const main = openTerminal('/p', '/p', 'p');
      setActiveWorkspace('/p', 'w1');
      const workspace = openTerminal('/wt/task', '/p', 'task');
      setActiveWorkspace('/p', MAIN);
      // Act
      removeProjectTerminals('/p');
      // Assert
      await until(() => sent('terminal_close').flatMap((c) => c.args.ids).length === 2);
      expect(sent('terminal_close').flatMap((c) => c.args.ids)).to.have.members([main, workspace]);
    });
  });
});
