import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
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
      return cmd.startsWith('list_') ? [] : null;
    });
    $projects.set([
      { id: '/p', name: 'p', path: '/p' },
      { id: '/q', name: 'q', path: '/q' },
    ]);
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
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
});
