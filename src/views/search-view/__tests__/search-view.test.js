import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectSearch, $searchDialogPrefs } from '../../../stores/search/search.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../search-view.js';

/** @typedef {import('../search-view.js').AcpSearchView} AcpSearchView */
/** @typedef {import('../../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/** @type {SearchDialogState} */
const STATE = { query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts' };

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** @param {AcpSearchView} view */
const dialog = (view) => /** @type {HTMLElementTagNameMap['acp-search-dialog']} */ (view.querySelector('acp-search-dialog'));

/**
 * One of the dialog's events, as the dialog fires it.
 * @param {AcpSearchView} view
 * @param {string} type
 * @param {object} detail
 */
function fire(view, type, detail) {
  dialog(view).dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/**
 * @param {Element} el
 * @param {string} type
 */
function listen(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

describe('acp-search-view', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string, args: Record<string, unknown>) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      return answer(cmd, a);
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    $projectSearch.setKey('/p', { ...STATE, recent: ['older'] });
  });

  afterEach(() => {
    $projectSearch.setKey('/p', undefined);
    $workspace.set(null);
    clearMocks();
  });

  async function render() {
    const view = /** @type {AcpSearchView} */ (await fixture(html`<acp-search-view></acp-search-view>`));
    await dialog(view).updateComplete;
    return view;
  }

  it("opens the dialog with the project's last search and recent queries, or the editor's selection, or empty for a project with none; with no project it says so", async () => {
    const view = await render();
    expect(view.open).to.equal(false);
    view.show();
    await until(() => view.open);
    const d = dialog(view);
    expect([d.hasProject, d.query, d.folder, d.mask, d.caseSensitive, d.recent]).to.deep.equal([true, 'needle', 'src', '*.ts', true, ['older']]);
    d.close();
    await until(() => !view.open);
    view.show('selected');
    await until(() => view.open);
    expect(dialog(view).query).to.equal('selected');
    dialog(view).close();

    $projectSearch.setKey('/p', undefined);
    await until(() => !view.open);
    view.show();
    await until(() => view.open);
    expect([dialog(view).query, dialog(view).folder, dialog(view).recent], 'no saved search').to.deep.equal(['', '', []]);
    dialog(view).close();
    $workspace.set(null);
    await view.updateComplete;
    expect(dialog(view).hasProject).to.equal(false);
  });

  it("searches in the dialog's slot, saves the project's search state, and cancels when the dialog closes", async () => {
    const view = await render();
    const options = { query: 'x', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };
    fire(view, 'acp-search-dialog-query', { options, state: { ...STATE, query: 'x' }, delay: 0 });
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    expect(calls.find((c) => c.cmd === 'find_in_files')?.args).to.include({ rootId: 'r', slot: 'dialog' });
    expect($projectSearch.get()['/p']).to.deep.include({ query: 'x', recent: ['older'] });
    fire(view, 'acp-search-dialog-close', {});
    await until(() => calls.some((c) => c.cmd === 'cancel_search' && c.args.slot === 'dialog'));
  });

  it("answers the folder menu with the project's folders and the query they answer; the latest question wins", async () => {
    /** @type {Record<string, (value: unknown) => void>} */
    const held = {};
    answer = (cmd, args) =>
      cmd === 'quick_open'
        ? new Promise((resolve) => (held[String(args.query)] = () => resolve({ items: [{ path: `src/${args.query}`, name: String(args.query), isDir: true, indices: [] }], cancelled: false })))
        : null;
    const view = await render();
    fire(view, 'acp-search-dialog-folders', { query: 'co' });
    fire(view, 'acp-search-dialog-folders', { query: 'comp' });
    await until(() => Object.keys(held).length === 2);
    held.comp(null);
    await until(() => dialog(view).foldersQuery === 'comp');
    held.co(null);
    await new Promise((r) => setTimeout(r, 30));
    expect([dialog(view).foldersQuery, dialog(view).folders.map((f) => f.path)], 'a late answer to older typing is dropped').to.deep.equal(['comp', ['src/comp']]);
    expect(calls.find((c) => c.cmd === 'quick_open')?.args).to.include({ rootId: 'r', kind: 'dirs' });
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    await view.updateComplete;
    fire(view, 'acp-search-dialog-folders', { query: 'x' });
    await until(() => dialog(view).foldersQuery === 'x');
    expect(dialog(view).folders, 'no root: no folders').to.deep.equal([]);
  });

  it('hands a match on as an absolute path with its position, records the query, and keeps the dialog’s own event inside', async () => {
    const view = await render();
    const opens = listen(view, 'acp-search-open');
    const leaked = listen(view, 'acp-search-dialog-open');
    fire(view, 'acp-search-dialog-open', { path: 'src/a.ts', line: 3, column: 7, length: 3, state: { ...STATE, query: 'foo' } });
    expect(opens).to.deep.equal([{ path: '/p/src/a.ts', line: 3, column: 7, length: 3 }]);
    expect(leaked).to.deep.equal([]);
    expect($projectSearch.get()['/p']?.recent).to.deep.equal(['foo', 'older']);
  });

  it('hands the search over to the Search pane on popout, recording the query', async () => {
    const view = await render();
    const popouts = listen(view, 'acp-search-popout');
    fire(view, 'acp-search-dialog-popout', { state: { ...STATE, query: 'bar' } });
    expect(popouts).to.deep.equal([{ state: { ...STATE, query: 'bar' } }]);
    expect($projectSearch.get()['/p']?.recent).to.deep.equal(['bar', 'older']);
  });

  it('saves layout changes and passes the prefs down', async () => {
    const view = await render();
    fire(view, 'acp-search-dialog-prefs', { patch: { view: 'flat' } });
    await view.updateComplete;
    expect($searchDialogPrefs.get().view).to.equal('flat');
    expect(dialog(view).view).to.equal('flat');
    fire(view, 'acp-search-dialog-prefs', { patch: { view: 'grouped' } });
  });
});
