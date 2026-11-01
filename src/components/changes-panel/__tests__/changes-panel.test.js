import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../changes-panel.js';

/** @typedef {import('../changes-panel.js').AcpChangesPanel} AcpChangesPanel */
/** @typedef {import('../../../models/types/types.js').GitFileStatus} GitFileStatus */

/**
 * @param {string} path
 * @param {Partial<GitFileStatus>} [fields]
 * @returns {GitFileStatus}
 */
const file = (path, fields = {}) => ({ path, origPath: null, kind: 'modified', staged: false, unstaged: true, added: 1, removed: 0, ...fields });

const FILES = [file('src/a.js'), file('b.md', { kind: 'renamed', origPath: 'old-b.md' }), file('new.txt', { kind: 'untracked', added: null })];

/** @param {Partial<AcpChangesPanel>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpChangesPanel} */ (await fixture(html`<acp-changes-panel></acp-changes-panel>`));
  Object.assign(el, { repo: { repo: { branch: 'main', upstream: null }, error: null }, root: '/p', ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, summary: () => root.querySelector('.acp-changes-panel__summary')?.textContent?.trim(), state: () => root.querySelector('.acp-changes-panel__state') };
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

describe('acp-changes-panel', () => {
  it('shows loading, an error, a folder that is no repository, and a clean tree, instead of the list; Refresh has a tooltip and asks to refresh', async () => {
    const loading = await render({ changes: { files: [], loaded: false, loading: true, error: null } });
    expect(loading.root.querySelector('md-progress-circular')?.getAttribute('aria-label')).to.equal('Loading changes');
    const failed = await render({ changes: { files: [], loaded: true, loading: false, error: 'git is gone' } });
    expect(failed.state()?.textContent).to.contain("Couldn't read changes").and.contain('git is gone');
    const none = await render({ changes: { files: [], loaded: true, loading: false, error: null }, repo: { repo: null, error: null } });
    expect(none.state()?.textContent).to.contain('Not a git repository');
    const clean = await render({ changes: { files: [], loaded: true, loading: false, error: null } });
    expect(clean.state()?.textContent).to.contain('No changes');
    expect(clean.summary()).to.equal('No changed files');
    expect(clean.root.querySelector('tvx-tree-view')).to.equal(null);
    const refreshes = listen(clean.el, 'acp-changes-refresh');
    expect(tooltipOf(clean.root.querySelector('.acp-changes-panel__refresh'))).to.equal('Refresh');
    expect(clean.root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
    /** @type {HTMLElement} */ (clean.root.querySelector('.acp-changes-panel__refresh')).click();
    expect(refreshes).to.have.length(1);
  });

  it('lists the changed files in groups for the tree, and sums up how many are picked', async () => {
    const { root, summary } = await render({ changes: { files: FILES, loaded: true, loading: false, error: null }, selection: new Set(['src/a.js']) });
    const tree = /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (root.querySelector('tvx-tree-view'));
    const items = /** @type {{ id: string, children?: { id: string }[] }[]} */ (/** @type {unknown} */ (tree.items));
    expect(items.map((g) => [g.id, g.children?.map((c) => c.id)])).to.deep.equal([
      ['group:changes', ['b.md', 'src/a.js']],
      ['group:untracked', ['new.txt']],
    ]);
    expect(summary()).to.equal('3 files · 1 selected');
    const all = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-changes-panel__all'));
    expect([all.checked, all.indeterminate]).to.deep.equal([false, true]);
  });

  it('picks everything with the all-files checkbox unless everything is picked already, then nothing', async () => {
    const { el, root } = await render({ changes: { files: FILES, loaded: true, loading: false, error: null } });
    const picks = listen(el, 'acp-commit-select');
    const all = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-changes-panel__all'));
    all.dispatchEvent(new Event('change'));
    expect(/** @type {{ ids: string[] }} */ (picks[0]).ids.sort()).to.deep.equal(['b.md', 'new.txt', 'src/a.js']);
    el.selection = new Set(['b.md', 'new.txt', 'src/a.js']);
    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 50)); // the tree takes the picks first
    const before = picks.length;
    all.dispatchEvent(new Event('change'));
    expect(picks.length - before, 'one event for the press').to.equal(1);
    expect(picks.at(-1)).to.deep.equal({ ids: [] });
  });

  it('commits the picked files, both sides of a rename, once the box asks, and tells the box how it went', async () => {
    const { el, root } = await render({ changes: { files: FILES, loaded: true, loading: false, error: null }, selection: new Set(['b.md', 'src/a.js']) });
    const commits = listen(el, 'acp-commit');
    const box = /** @type {HTMLElementTagNameMap['acp-commit-box']} */ (root.querySelector('acp-commit-box'));
    expect(box.included, 'the box knows how many files').to.equal(2);
    const leaked = listen(el, 'acp-commit-submit');
    box.dispatchEvent(new CustomEvent('acp-commit-submit', { detail: { message: 'Rename b', amend: false }, bubbles: true, composed: true }));
    expect(leaked, 'the box’s own event stays inside').to.deep.equal([]);
    expect(commits).to.have.length(1);
    const detail = /** @type {{ paths: string[], message: string, amend: boolean }} */ (commits[0]);
    expect([detail.message, detail.amend]).to.deep.equal(['Rename b', false]);
    expect(detail.paths.sort()).to.deep.equal(['b.md', 'old-b.md', 'src/a.js']);

    // The box locked itself when it asked; the panel forwards the answer to it.
    box.message = 'Rename b';
    box.amend = true;
    box.committing = true;
    await box.updateComplete;
    el.commitFinished(false);
    await box.updateComplete;
    expect([box.committing, box.message, box.amend], 'a failure unlocks and keeps the form').to.deep.equal([false, 'Rename b', true]);
    el.fillAmendMessage('Last commit');
    expect(box.message, 'the box takes the last message while Amend is on').to.equal('Last commit');
    el.commitFinished(true);
    expect([box.committing, box.message, box.amend], 'a success clears it').to.deep.equal([false, '', false]);
  });

  it('opens the diff of a file whose name is clicked, at its absolute path', async () => {
    const { el, root } = await render({ changes: { files: FILES, loaded: true, loading: false, error: null } });
    const opens = listen(el, 'acp-diff-open');
    const tree = /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (root.querySelector('tvx-tree-view'));
    const render1 = /** @type {(node: unknown) => import('lit').TemplateResult} */ (tree.renderItemLabel);
    const group = /** @type {{ children: unknown[] }[]} */ (/** @type {unknown} */ (tree.items))[0];
    const host = document.createElement('div');
    const { render: litRender } = await import('lit');
    litRender(render1(group.children[1]), host);
    /** @type {HTMLElement} */ (host.querySelector('span')).click();
    expect(opens).to.deep.equal([{ path: '/p/src/a.js' }]);
  });
});
