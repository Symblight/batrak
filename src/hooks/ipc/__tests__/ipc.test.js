import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { ipc } from '../ipc.js';

describe('ipc', () => {
  afterEach(() => clearMocks());

  it('is one frozen object of the Tauri bridge, with nothing about any feature in it', () => {
    expect(Object.isFrozen(ipc)).to.equal(true);
    expect(Object.keys(ipc).sort()).to.deep.equal(['channel', 'homeDir', 'invoke', 'listen', 'onDragDrop', 'pickFolder']);
  });

  it('invokes a command with its arguments and resolves with the answer', async () => {
    /** @type {{ cmd: string, args: unknown }[]} */
    const calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return 42;
    });
    expect(await ipc.invoke('some_command', { a: 1 })).to.equal(42);
    expect(calls).to.deep.equal([{ cmd: 'some_command', args: { a: 1 } }]);
  });

  it('can be taken apart, since no member uses this', async () => {
    mockIPC(() => 'ok');
    const { invoke } = ipc;
    expect(await invoke('x')).to.equal('ok');
  });

  it('makes a channel that hands its messages to the callback', () => {
    mockIPC(() => null);
    /** @type {string[]} */
    const got = [];
    const channel = ipc.channel((/** @type {string} */ message) => got.push(message));
    channel.onmessage('hello');
    expect(got).to.deep.equal(['hello']);
  });

  it('listens to an event with its payload, until it is stopped', async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    /** @type {unknown[]} */
    const got = [];
    const stop = await ipc.listen('thing://happened', (payload) => got.push(payload));
    await emit('thing://happened', { n: 1 });
    stop();
    await emit('thing://happened', { n: 2 });
    expect(got).to.deep.equal([{ n: 1 }]);
  });

  it('picks a folder as a path, or null when cancelled', async () => {
    mockIPC((cmd) => (cmd === 'plugin:dialog|open' ? '/home/me/project' : null));
    expect(await ipc.pickFolder()).to.equal('/home/me/project');
    mockIPC(() => null);
    expect(await ipc.pickFolder()).to.equal(null);
  });

  it('knows the home folder', async () => {
    mockIPC((cmd) => (cmd === 'plugin:path|resolve_directory' ? '/home/me' : null));
    expect(await ipc.homeDir()).to.equal('/home/me');
  });
});
