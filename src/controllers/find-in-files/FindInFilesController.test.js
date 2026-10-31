import { LitElement, html as litHtml } from 'lit';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../test/fixture.js';
import { FindInFilesController } from './FindInFilesController.js';
import { $workspace } from '../../stores/workspace.js';

class DialogSearchHost extends LitElement {
  search = new FindInFilesController(this, { slot: 'dialog' });

  render() {
    return litHtml``;
  }
}
customElements.define('test-find-in-files-host', DialogSearchHost);

/** @type {import('../../models/types.js').SearchOptions} */
const OPTIONS = { query: 'needle', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('FindInFilesController', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    clearMocks();
    $workspace.set(null);
  });

  it('searches and cancels in its own slot', async () => {
    const el = /** @type {DialogSearchHost} */ (await fixture(html`<test-find-in-files-host></test-find-in-files-host>`));
    el.search.setActive(true);
    el.search.search(OPTIONS, 0);
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    const search = calls.find((c) => c.cmd === 'find_in_files');
    expect(search?.args).to.include({ rootId: 'r', slot: 'dialog' });
    expect(search?.args.options).to.deep.equal(OPTIONS);

    el.search.setActive(false);
    await until(() => calls.some((c) => c.cmd === 'cancel_search'));
    expect(calls.find((c) => c.cmd === 'cancel_search')?.args).to.deep.equal({ rootId: 'r', slot: 'dialog' });
  });

  it("keeps an error's source: the query or a filter", async () => {
    /** @type {((event: unknown) => void) | null} */
    let send = null;
    mockIPC((cmd, args) => {
      if (cmd === 'find_in_files') send = /** @type {{ channel: { onmessage: (event: unknown) => void } }} */ (args).channel.onmessage;
      return null;
    });
    const el = /** @type {DialogSearchHost} */ (await fixture(html`<test-find-in-files-host></test-find-in-files-host>`));
    el.search.setActive(true);
    el.search.search({ ...OPTIONS, regex: true, query: '(' }, 0);
    await until(() => send !== null);
    /** @type {(event: unknown) => void} */ (/** @type {unknown} */ (send))({ kind: 'error', message: 'unclosed group', source: 'query' });
    expect(el.search.error).to.equal('unclosed group');
    expect(el.search.errorSource).to.equal('query');

    send = null;
    el.search.search({ ...OPTIONS, include: 'src/[' }, 0);
    await until(() => send !== null);
    expect(el.search.error, 'a new search clears the error').to.equal('');
    expect(el.search.errorSource).to.equal(null);
    /** @type {(event: unknown) => void} */ (/** @type {unknown} */ (send))({ kind: 'error', message: 'unclosed class', source: 'filter' });
    expect(el.search.errorSource).to.equal('filter');
  });
});
