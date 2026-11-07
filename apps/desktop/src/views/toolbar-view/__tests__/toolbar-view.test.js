import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $gitCompare, $gitRepo, NO_COMPARE, NO_REPO } from '../../../stores/git/git.js';
import { $hiddenColumns } from '../../../stores/layout/layout.js';
import { $projects } from '../../../stores/projects/projects.js';
import { $project } from '../../../stores/project/project.js';
import '../toolbar-view.js';

/** @typedef {import('../toolbar-view.js').AcpToolbarView} AcpToolbarView */

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

describe('acp-toolbar-view', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      if (cmd === 'open_root') return { rootId: `root:${a.path}`, path: a.path };
      if (cmd === 'git_branches') return { local: ['main', 'dev'], remotes: [], default: null };
      return cmd.startsWith('list_') ? [] : null;
    });
    $projects.set([
      { id: '/p', name: 'p', path: '/p' },
      { id: '/q', name: 'q', path: '/q' },
    ]);
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $gitCompare.set(NO_COMPARE);
    $gitRepo.set(NO_REPO);
    $projects.set([]);
    $project.set(null);
    $hiddenColumns.set([]);
    clearMocks();
  });

  /** The view, and a way to fire the toolbar's events. */
  async function render() {
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    /** @param {string} type @param {unknown} [detail] */
    const fire = (type, detail = null) => toolbar.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    return { view, toolbar, fire };
  }

  it('hands the projects to the toolbar, and switches and removes as the menu asks', async () => {
    // Arrange
    const { view, toolbar, fire } = await render();
    expect(toolbar.projects.map((p) => p.id), 'the listed projects').to.deep.equal(['/p', '/q']);

    // Act: switch
    fire('acp-project-select', { projectId: '/q' });
    await until(() => calls.some((c) => c.cmd === 'open_root' && c.args.path === '/q'));
    // Act: remove asks first
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (view.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return true;
    };
    fire('acp-project-remove', { projectId: '/q' });
    await until(() => $projects.get().length === 1);

    // Assert
    expect(asked).to.deep.equal(['Remove project?']);
    expect($projects.get().map((p) => p.id)).to.deep.equal(['/p']);
  });

  it('hides a column and opens a page as the toolbar asks', async () => {
    // Arrange
    const { toolbar, fire } = await render();

    // Act
    fire('acp-column-toggle', { column: 'side' });
    await toolbar.updateComplete;
    fire('acp-github-open', { url: 'https://example.test/pr/1' });
    await until(() => calls.some((c) => c.cmd === 'open_url'));

    // Assert
    expect(toolbar.hiddenColumns, 'the toolbar sees it hidden').to.deep.equal(['side']);
    expect(calls.find((c) => c.cmd === 'open_url')?.args).to.deep.equal({ url: 'https://example.test/pr/1' });
  });

  it('gives the card the comparison, and loads the branches without the current one when its menu opens; no fetch', async () => {
    // Arrange
    $gitRepo.set({ repo: /** @type {import('../../../hooks/git/types.js').GitRepoState} */ ({ branch: 'main', sha: 'a1', detached: false, upstream: null, ahead: 0, behind: 0 }), error: null });
    $gitCompare.set({ ...NO_COMPARE, target: 'dev' });
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    await toolbar.updateComplete;
    const card = /** @type {HTMLElementTagNameMap['acp-branch-popover']} */ (/** @type {ShadowRoot} */ (toolbar.shadowRoot).querySelector('acp-branch-popover'));
    // Act
    await card.loadBranches?.();
    await view.updateComplete;
    await toolbar.updateComplete;
    // Assert
    expect(card.compareTo).to.equal('dev');
    expect(card.branches.local).to.deep.equal(['dev']);
    expect(calls.find((c) => c.cmd === 'git_branches')?.args).to.deep.equal({ rootId: 'r' });
    expect(calls.some((c) => c.cmd === 'git_fetch')).to.equal(false);
  });

  it('never shows another project’s branches: a switch clears them, a late answer is dropped, and a failed load shows none', async () => {
    // Arrange
    /** @type {{ resolve: (list: unknown) => void, reject: (err: unknown) => void }[]} */
    const asked = [];
    mockIPC((cmd) => {
      if (cmd === 'git_branches') return new Promise((resolve, reject) => asked.push({ resolve, reject }));
      return cmd.startsWith('list_') ? [] : null;
    });
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    const loadBranches = /** @type {() => Promise<void>} */ (toolbar.loadBranches);
    const list = (/** @type {string} */ name) => ({ local: [name], remotes: [], default: null });
    const first = loadBranches();
    asked[0].resolve(list('of-p'));
    await first;
    const loaded = view.branches.local;
    // Act: another project is shown, and a late answer for this one comes after
    const late = loadBranches();
    $project.set({ path: '/q', name: 'q', rootId: 'r2' });
    const afterSwitch = view.branches.local;
    asked[1].resolve(list('late-of-p'));
    await late;
    const afterLate = view.branches.local;
    const failed = loadBranches();
    asked[2].reject(new Error('git failed'));
    await failed;
    // Assert
    expect(loaded).to.deep.equal(['of-p']);
    expect(afterSwitch).to.deep.equal([]);
    expect(afterLate).to.deep.equal([]);
    expect(view.branches.local).to.deep.equal([]);
  });
});
