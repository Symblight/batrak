import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect } from '@esm-bundle/chai';
import { projects } from '../projects.js';

describe('projects files', () => {
  /** @type {{ cmd: string, args: unknown }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === 'read_file' ? 'text' : null;
    });
  });

  afterEach(() => clearMocks());

  it('asks the backend for a file, a folder or a rescan with the arguments it names', async () => {
    /** @type {[() => Promise<unknown>, string, unknown][]} */
    const cases = [
      [() => projects.readFile('/p/a.js'), 'read_file', { path: '/p/a.js' }],
      [() => projects.readFileBytes('/p/a.png'), 'read_file_bytes', { path: '/p/a.png' }],
      [() => projects.writeFile('/p/.brama/agents.json', '{}'), 'write_file', { path: '/p/.brama/agents.json', content: '{}' }],
      [() => projects.listDir('root:/p', 'src'), 'list_dir', { rootId: 'root:/p', path: 'src' }],
      [() => projects.rescan('root:/p'), 'rescan_root', { rootId: 'root:/p' }],
      [() => projects.closeRoot('root:/p'), 'close_root', { rootId: 'root:/p' }],
    ];
    for (const [call, cmd, args] of cases) {
      calls = [];
      await call();
      expect(calls, cmd).to.deep.equal([{ cmd, args }]);
    }
    expect(await projects.readFile('/p/a.js')).to.equal('text');
  });
});
