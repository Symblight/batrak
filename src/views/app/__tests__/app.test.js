import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectSearch, $searchDialogPrefs } from '../../../stores/search/search.js';
import { $hiddenColumns } from '../../../stores/layout/layout.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../app.js';

/** @typedef {import('../app.js').AcpApp} AcpApp */
/** @typedef {import('../../../models/types/types.js').SearchDialogState} SearchDialogState */

/** @type {SearchDialogState} */
const STATE = { query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts' };

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A shortcut pressed anywhere in the window.
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function shortcut(key, init = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...init }));
}

/** @param {AcpApp} app */
const searchDialog = (app) => /** @type {HTMLElementTagNameMap['acp-search-dialog']} */ (app.shadowRoot?.querySelector('acp-search-dialog'));
/** @param {AcpApp} app */
const quickOpen = (app) => /** @type {HTMLElementTagNameMap['acp-quick-open']} */ (app.shadowRoot?.querySelector('acp-quick-open'));
/** @param {AcpApp} app */
const mainColumn = (app) => /** @type {HTMLElementTagNameMap['acp-main-column']} */ (app.shadowRoot?.querySelector('acp-main-column'));
/** @param {AcpApp} app */
const fileColumn = (app) => /** @type {HTMLElementTagNameMap['acp-file-column']} */ (app.shadowRoot?.querySelector('acp-file-column'));

/**
 * Fires one of the dialog's events, as the dialog would.
 * @param {AcpApp} app
 * @param {string} type
 * @param {object} detail
 */
function fire(app, type, detail) {
  searchDialog(app).dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/**
 * An empty answer for the commands `<acp-app>` sends as it starts: lists, the agent list and a sync report are empty,
 * the rest `null`.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function startupAnswer(cmd, args) {
  if (cmd === 'sessions_sync') return { projectPath: args.projectPath, startedAt: '', endedAt: '', agents: [] };
  if (cmd === 'agents_list') return { agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] };
  return cmd.startsWith('list_') ? [] : null;
}

describe('acp-app: search dialog', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string, args: Record<string, unknown>) => unknown} A test's own answers; `undefined` falls back to `startupAnswer`. */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => undefined;
    // Startup (sessions, git, terminals, agents…) gets empty answers; the search commands are checked.
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      return answer(cmd, a) ?? startupAnswer(cmd, a);
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    $projectSearch.setKey('/p', { ...STATE, recent: ['older'] });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    for (const el of document.querySelectorAll('acp-app')) {
      searchDialog(/** @type {AcpApp} */ (el))?.close();
      el.parentElement?.remove();
    }
    $projectSearch.setKey('/p', undefined);
    $workspace.set(null);
    clearMocks();
  });

  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await searchDialog(app).updateComplete;
    return app;
  }

  it("opens on Mod+Shift+F with the project's last search, not the side pane", async () => {
    const app = await render();
    shortcut('F', { shiftKey: true });
    await until(() => searchDialog(app).open);
    const dialog = searchDialog(app);
    expect(app.sideView).to.equal('files');
    expect(dialog.hasProject).to.equal(true);
    expect(dialog.query).to.equal('needle');
    expect(dialog.folder).to.equal('src');
    expect(dialog.mask).to.equal('*.ts');
    expect(dialog.caseSensitive).to.equal(true);
    expect(dialog.recent).to.deep.equal(['older']);
  });

  it('ignores the other shortcuts while the dialog is open', async () => {
    const app = await render();
    shortcut('F', { shiftKey: true });
    await until(() => searchDialog(app).open);
    shortcut('p');
    await app.updateComplete;
    expect(quickOpen(app).shadowRoot?.querySelector('dialog')?.open ?? false).to.equal(false);
  });

  it("searches in the dialog's slot and saves the project's search state", async () => {
    const app = await render();
    const options = { query: 'x', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };
    fire(app, 'acp-search-dialog-query', { options, state: { ...STATE, query: 'x' }, delay: 0 });
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    expect(calls.find((c) => c.cmd === 'find_in_files')?.args).to.include({ rootId: 'r', slot: 'dialog' });
    expect($projectSearch.get()['/p']).to.deep.include({ query: 'x', recent: ['older'] });

    fire(app, 'acp-search-dialog-close', {});
    await until(() => calls.some((c) => c.cmd === 'cancel_search' && c.args.slot === 'dialog'));
  });

  it("answers the folder menu with the project's folders and the query they answer", async () => {
    answer = (cmd, args) =>
      cmd === 'quick_open' ? { items: [{ path: `src/${args.query}`, name: String(args.query), isDir: true, indices: [] }], cancelled: false } : undefined;
    const app = await render();
    fire(app, 'acp-search-dialog-folders', { query: 'comp' });
    await until(() => searchDialog(app).foldersQuery === 'comp');
    expect(calls.find((c) => c.cmd === 'quick_open')?.args).to.deep.equal({ rootId: 'r', query: 'comp', kind: 'dirs' });
    expect(searchDialog(app).folders.map((f) => f.path)).to.deep.equal(['src/comp']);
  });

  it('opens a match in its tab, selected, and records the query', async () => {
    const app = await render();
    /** @type {unknown[][]} */
    const opened = [];
    mainColumn(app).openFile = (...args) => void opened.push(args);
    fire(app, 'acp-search-dialog-open', { path: 'src/a.ts', line: 3, column: 7, length: 3, state: { ...STATE, query: 'foo' } });
    expect(opened).to.deep.equal([['/p/src/a.ts', { line: 3, column: 7, length: 3 }]]);
    expect($projectSearch.get()['/p']?.recent).to.deep.equal(['foo', 'older']);
  });

  it('hands the search over to the Search pane on popout', async () => {
    const app = await render();
    /** @type {unknown[]} */
    const shown = [];
    fileColumn(app).showSearch = async (state) => void shown.push(state);
    fire(app, 'acp-search-dialog-popout', { state: { ...STATE, query: 'bar' } });
    await app.updateComplete;
    expect(app.sideView).to.equal('search');
    expect(shown).to.deep.equal([{ ...STATE, query: 'bar' }]);
    expect($projectSearch.get()['/p']?.recent).to.deep.equal(['bar', 'older']);
  });

  it('saves layout changes and passes the prefs down', async () => {
    const app = await render();
    fire(app, 'acp-search-dialog-prefs', { patch: { view: 'flat' } });
    await app.updateComplete;
    expect($searchDialogPrefs.get().view).to.equal('flat');
    expect(searchDialog(app).view).to.equal('flat');
    fire(app, 'acp-search-dialog-prefs', { patch: { view: 'grouped' } });
  });
});
