import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectSearch } from '../../../stores/search/search.js';
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
const searchDialog = (app) => /** @type {HTMLElementTagNameMap['acp-search-dialog']} */ (app.querySelector('acp-search-dialog'));
/** @param {AcpApp} app */
const quickOpen = (app) => /** @type {HTMLElementTagNameMap['acp-quick-open']} */ (app.querySelector('acp-quick-open'));
/** @param {AcpApp} app */
const mainColumn = (app) => /** @type {HTMLElementTagNameMap['acp-main-column']} */ (app.querySelector('acp-main-column'));
/** @param {AcpApp} app */
const fileColumn = (app) => /** @type {HTMLElementTagNameMap['acp-file-column']} */ (app.querySelector('acp-file-column'));

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
    for (const el of document.querySelectorAll('acp-app')) searchDialog(/** @type {AcpApp} */ (el))?.close();
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

  it('opens a match from the dialog in its tab, selected', async () => {
    const app = await render();
    /** @type {unknown[][]} */
    const opened = [];
    mainColumn(app).openFile = (...args) => void opened.push(args);
    fire(app, 'acp-search-dialog-open', { path: 'src/a.ts', line: 3, column: 7, length: 3, state: { ...STATE, query: 'foo' } });
    expect(opened).to.deep.equal([['/p/src/a.ts', { line: 3, column: 7, length: 3 }]]);
  });

  it('shows the Search pane with the dialog’s search on popout', async () => {
    const app = await render();
    /** @type {unknown[]} */
    const shown = [];
    fileColumn(app).showSearch = async (state) => void shown.push(state);
    fire(app, 'acp-search-dialog-popout', { state: { ...STATE, query: 'bar' } });
    await app.updateComplete;
    expect(app.sideView).to.equal('search');
    expect(shown).to.deep.equal([{ ...STATE, query: 'bar' }]);
  });
});
