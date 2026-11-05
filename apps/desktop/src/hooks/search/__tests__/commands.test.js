import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect } from '@esm-bundle/chai';
import { search } from '../search.js';

describe('search commands', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
      return null;
    });
  });

  afterEach(() => clearMocks());

  it('quick-opens files unless told otherwise, searches into a channel and cancels by slot', async () => {
    await search.quickOpen('root:/p', 'app');
    await search.quickOpen('root:/p', 'src', 'dirs');
    await search.find('root:/p', 'panel', /** @type {never} */ ({ query: 'x' }), () => {});
    await search.cancel('root:/p', 'panel');
    expect(calls.map((c) => c.cmd)).to.deep.equal(['quick_open', 'quick_open', 'find_in_files', 'cancel_search']);
    expect(calls[0].args).to.deep.equal({ rootId: 'root:/p', query: 'app', kind: 'files' });
    expect(calls[1].args).to.include({ kind: 'dirs' });
    expect(calls[2].args, 'search').to.include({ rootId: 'root:/p', slot: 'panel' });
    expect(calls[2].args.channel, 'results stream into a channel').to.exist;
    expect(calls[3].args).to.deep.equal({ rootId: 'root:/p', slot: 'panel' });
  });
});
