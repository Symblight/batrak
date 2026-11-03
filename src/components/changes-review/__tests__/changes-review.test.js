import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../changes-review.js';

/** @typedef {import('../../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/** @type {GitFileStatus} */
const RENAMED = { path: 'src/b.js', kind: 'renamed', staged: false, unstaged: true, origPath: 'src/a.js', added: 1, removed: 0 };

/** @type {GitFileStatus[]} */
const FILES = [
  { path: 'src/z.js', kind: 'modified', staged: false, unstaged: true, origPath: null, added: 3, removed: 1 },
  RENAMED,
  { path: 'new.txt', kind: 'untracked', staged: false, unstaged: true, origPath: null, added: null, removed: null },
];
const CHANGES = { files: FILES, loaded: true, loading: false, error: null };
/** @type {import('../../../hooks/git/types.js').GitRepoView} */
const REPO = { repo: { branch: 'main', sha: 'abc', detached: false, upstream: null, ahead: 0, behind: 0, upstreamSha: null, remote: null }, error: null };
/** @type {import('../../../hooks/tabs/types.js').FileDiff} */
const DIFF = { content: 'new', baseline: 'old', loading: false, error: '' };

/** @param {Partial<HTMLElementTagNameMap['acp-changes-review']>} [props] */
async function render(props = {}) {
  const el = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (
    await fixture(html`<acp-changes-review .changes=${CHANGES} .repo=${REPO} .root=${'/p'}></acp-changes-review>`)
  );
  Object.assign(el, props);
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const rows = () => /** @type {HTMLElementTagNameMap['acp-change-row'][]} */ ([...root.querySelectorAll('acp-change-row')]);
  return { el, root, rows };
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

describe('acp-changes-review', () => {
  it('lists the changed files sorted by path as rows, with the totals and how many are picked', async () => {
    const { root, rows } = await render({ selection: new Set(['src/b.js']) });
    expect(rows().map((r) => r.row?.id)).to.deep.equal(['new.txt', 'src/b.js', 'src/z.js']);
    expect(rows().map((r) => [r.picked, r.expanded, r.selectable])).to.deep.equal([
      [false, false, true],
      [true, false, true],
      [false, false, true],
    ]);
    expect(root.querySelector('.acp-changes-review__summary')?.textContent).to.equal('1/3 files selected');
    const totals = /** @type {HTMLElementTagNameMap['acp-diff-counts']} */ (root.querySelector('.acp-changes-review__toolbar acp-diff-counts'));
    expect([totals.added, totals.removed]).to.deep.equal([4, 1]);
    const all = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-changes-review__all'));
    expect([all.checked, all.indeterminate]).to.deep.equal([false, true]);
  });

  it('shows an expanded file as a card with its diff, or a loading or failed state instead of the editor, and the toolbar collapses all', async () => {
    const { el, root, rows } = await render({ expanded: new Set(['src/b.js']), diffs: new Map([['src/b.js', DIFF]]) });
    const card = root.querySelector('.acp-changes-review__card');
    expect(card?.querySelector('acp-change-row')?.row?.id).to.equal('src/b.js');
    expect(rows().filter((r) => r.expanded).map((r) => r.row?.id)).to.deep.equal(['src/b.js']);
    expect(card?.querySelector('cdx-code-editor')?.getAttribute('filename')).to.equal('src/b.js');
    const collapses = listen(el, 'acp-changes-collapse');
    /** @type {HTMLElement} */ (root.querySelector('.acp-changes-review__tool')).click();
    expect(collapses).to.have.length(1);

    el.diffs = new Map([['src/b.js', { ...DIFF, content: '', baseline: '', loading: true }]]);
    await el.updateComplete;
    expect(root.querySelector('.acp-changes-review__diff md-progress-circular')?.getAttribute('aria-label')).to.equal('Loading diff');
    el.diffs = new Map([['src/b.js', { ...DIFF, error: 'too big' }]]);
    await el.updateComplete;
    expect(root.querySelector('.acp-changes-review__diff-state')?.textContent).to.contain('too big');
    expect(root.querySelector('cdx-code-editor')).to.equal(null);
  });

  it('is one tree with a single Tab stop that the arrows, Home and End move between the files', async () => {
    const { root, rows } = await render({ expanded: new Set(['src/b.js']), diffs: new Map([['src/b.js', DIFF]]) });
    const active = () => /** @type {HTMLElementTagNameMap['acp-change-row'] | null} */ (root.activeElement)?.row?.id;
    const stops = () => rows().filter((r) => r.tabStop).map((r) => r.row?.id);
    // A row focuses itself after its render, a microtask later
    const press = async (/** @type {number} */ i, /** @type {string} */ key) => {
      rows()[i].shadowRoot?.querySelector('[role="treeitem"]')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    expect(root.querySelector('[role="tree"]')).to.not.equal(null);
    expect(stops()).to.deep.equal(['new.txt']);
    // Act + Assert: Down skips the diff between two rows
    await press(0, 'ArrowDown');
    expect(active()).to.equal(rows()[1].row?.id);
    expect(stops()).to.deep.equal(['src/b.js']);
    await press(1, 'End');
    expect(active()).to.equal(rows()[2].row?.id);
    await press(2, 'Home');
    expect(active()).to.equal(rows()[0].row?.id);
  });

  it('picks everything with the all-files checkbox unless everything is picked, then nothing', async () => {
    const { el, root } = await render();
    const selects = listen(el, 'acp-commit-select');
    const all = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-changes-review__all'));
    all.dispatchEvent(new Event('change', { bubbles: true }));
    el.selection = new Set(['new.txt', 'src/b.js', 'src/z.js']);
    await el.updateComplete;
    all.dispatchEvent(new Event('change', { bubbles: true }));
    expect(selects).to.deep.equal([{ ids: ['new.txt', 'src/b.js', 'src/z.js'] }, { ids: [] }]);
  });

  it('turns a row’s Edit into opening the file at its absolute path, and lets the row’s own events through', async () => {
    const { el, rows } = await render();
    const opens = listen(el, 'acp-file-open');
    const toggles = listen(el, 'acp-change-toggle');
    const leaked = listen(el, 'acp-change-edit');
    const row = rows()[1];
    row.dispatchEvent(new CustomEvent('acp-change-edit', { detail: { id: 'src/b.js' }, bubbles: true, composed: true }));
    row.dispatchEvent(new CustomEvent('acp-change-toggle', { detail: { id: 'src/b.js' }, bubbles: true, composed: true }));
    expect(opens).to.deep.equal([{ path: '/p/src/b.js' }]);
    expect(leaked, 'the row’s Edit is the review’s open').to.deep.equal([]);
    expect(toggles).to.deep.equal([{ id: 'src/b.js' }]);
  });

  it('scrolls to and focuses a file’s row, now or once it is listed, only after every row has rendered', async () => {
    const { el, root, rows } = await render();
    /** @param {HTMLElementTagNameMap['acp-change-row']} row */
    const focused = (row) => row.shadowRoot?.activeElement?.classList.contains('acp-change-row__row');
    /** @type {boolean[]} Whether every row was laid out (not 0px tall) when the scroll target was computed. */
    const laidOut = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView() {
      const all = /** @type {HTMLElement[]} */ ([...(/** @type {ShadowRoot} */ (this.getRootNode())).querySelectorAll('acp-change-row')]);
      laidOut.push(all.length > 0 && all.every((row) => row.getBoundingClientRect().height > 0));
    };
    try {
      el.scrollToChange('src/z.js');
      await el.updateComplete;
      await rows()[2].updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focused(rows()[2]), 'a file that is listed').to.equal(true);
      el.scrollToChange('later.js');
      await el.updateComplete;
      el.changes = { ...CHANGES, files: [...FILES, /** @type {GitFileStatus} */ ({ path: 'later.js', kind: 'added', staged: false, unstaged: true, origPath: null, added: 1, removed: 0 })] };
      await el.updateComplete;
      const later = /** @type {HTMLElementTagNameMap['acp-change-row']} */ (root.querySelector('acp-change-row[data-id="later.js"]'));
      await later.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focused(later), 'a row added by the same update takes the focus once rendered').to.equal(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(laidOut, 'each scroll came with every row laid out').to.deep.equal([true, true]);
  });

  it('says why there is no list: loading, an error, no repository, nothing changed', async () => {
    const text = (/** @type {Awaited<ReturnType<typeof render>>} */ view) => view.root.querySelector('.acp-changes-review__state')?.textContent;
    expect((await render({ changes: { files: [], loaded: false, loading: true, error: null } })).root.querySelector('md-progress-circular')).to.not.equal(null);
    expect(text(await render({ changes: { files: [], loaded: true, loading: false, error: 'boom' } }))).to.contain('boom');
    expect(text(await render({ changes: { files: [], loaded: true, loading: false, error: null }, repo: { repo: null, error: null } }))).to.contain('Not a git repository');
    expect(text(await render({ changes: { files: [], loaded: true, loading: false, error: null }, repo: REPO }))).to.contain('The working tree matches HEAD.');
  });

  it("explains a session's Apply and Check out in tooltips, and lists its changes read-only", async () => {
    const { root, rows } = await render({ base: 'abc1234def', branch: 'brama/fix-1' });
    expect([...root.querySelectorAll('.acp-changes-review__session-action')].map(tooltipOf)).to.deep.equal([
      'Bring the changes into the project, unstaged',
      'Check brama/fix-1 out in the project',
    ]);
    expect(rows().every((r) => !r.selectable), 'nothing to pick').to.equal(true);
    expect(root.querySelector('.acp-changes-review__summary')?.textContent).to.equal('3 files changed since abc1234');
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
