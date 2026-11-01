import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../change-row.js';

/** @typedef {import('../change-row.js').AcpChangeRow} AcpChangeRow */
/** @typedef {import('../../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/**
 * @param {Partial<GitFileStatus>} [fields]
 * @returns {import('../../../hooks/git/changes.js').ChangeRow}
 */
function rowOf(fields = {}) {
  const file = /** @type {GitFileStatus} */ ({ path: 'src/b.js', origPath: null, kind: 'modified', staged: false, unstaged: true, added: 4, removed: 1, ...fields });
  return { id: file.path, name: 'b.js', dir: 'src', file };
}

/** @param {Partial<AcpChangeRow>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpChangeRow} */ (await fixture(html`<acp-change-row></acp-change-row>`));
  Object.assign(el, { row: rowOf(), ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, row: /** @type {HTMLElement} */ (root.querySelector('.acp-change-row__row')) };
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

describe('acp-change-row', () => {
  it('is a tree item at level 1 that is a Tab stop only while it holds the tree\'s', async () => {
    const { el, row } = await render();
    expect([row.getAttribute('role'), row.getAttribute('aria-level'), row.tabIndex]).to.deep.equal(['treeitem', '1', 0]);
    el.tabStop = false;
    await el.updateComplete;
    expect(row.tabIndex).to.equal(-1);
  });

  it('shows the type badge, name, folder, counts and a picked checkbox with the full path in a tooltip, a rename relative to the folder, and a deleted file struck out', async () => {
    const { root, row } = await render({ picked: true });
    expect(root.querySelector('.acp-change-row__badge')?.textContent).to.equal('JS');
    expect(root.querySelector('.acp-change-row__name')?.textContent).to.equal('b.js');
    expect(root.querySelector('.acp-change-row__dir')?.textContent).to.equal('src');
    expect(tooltipOf(root.querySelector('.acp-change-row__name'))).to.equal('src/b.js');
    const counts = /** @type {HTMLElementTagNameMap['acp-diff-counts']} */ (root.querySelector('acp-diff-counts'));
    expect([counts.added, counts.removed]).to.deep.equal([4, 1]);
    expect(/** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-change-row__pick')).checked).to.equal(true);
    expect(row.getAttribute('aria-expanded')).to.equal('false');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);

    const renamed = await render({ row: { ...rowOf({ path: 'src/new/b.js', origPath: 'src/old/b.js' }), dir: 'src/new' } });
    expect(renamed.root.querySelector('.acp-change-row__renamed')?.textContent).to.equal('(../old/b.js)');
    expect(tooltipOf(renamed.root.querySelector('.acp-change-row__renamed'))).to.equal('Renamed from src/old/b.js');

    const deleted = await render({ row: rowOf({ kind: 'deleted' }) });
    expect(deleted.root.querySelector('.acp-change-row__name_deleted')).to.not.equal(null);
    expect(/** @type {HTMLElementTagNameMap['md-icon-button']} */ (deleted.root.querySelector('.acp-change-row__action')).disabled, 'Edit is disabled').to.equal(true);
  });

  it('has Edit and Revert with tooltips (shown by CSS while hovered, focused or expanded), and Edit asks to open the file without toggling', async () => {
    const { el, root } = await render();
    const edits = listen(el, 'acp-change-edit');
    const toggles = listen(el, 'acp-change-toggle');
    const actions = [...root.querySelectorAll('.acp-change-row__action')];
    expect(actions.map(tooltipOf)).to.deep.equal(['Edit', 'Not available yet']);
    expect(/** @type {HTMLElementTagNameMap['md-icon-button']} */ (actions[1]).disabled, 'Revert does not exist yet').to.equal(true);
    /** @type {HTMLElement} */ (actions[0]).click();
    expect(edits).to.deep.equal([{ id: 'src/b.js' }]);
    expect(toggles, 'Edit does not toggle the row').to.deep.equal([]);
    expect(el.hasAttribute('expanded'), 'a collapsed row').to.equal(false);
    el.expanded = true;
    await el.updateComplete;
    expect(el.hasAttribute('expanded'), 'the attribute the header styling keys on').to.equal(true);
  });

  it('toggles on a click, Enter or Space, expands on ArrowRight and collapses on ArrowLeft only while expanded', async () => {
    const { el, row } = await render();
    const toggles = listen(el, 'acp-change-toggle');
    const expands = listen(el, 'acp-change-expand');
    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(toggles).to.have.length(3);
    expect(expands).to.deep.equal([{ id: 'src/b.js' }]);
    el.expanded = true;
    await el.updateComplete;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(expands, 'already expanded').to.have.length(1);
    expect(toggles, 'collapsed again').to.have.length(4);
  });

  it('asks to pick or unpick the file without toggling, and has no checkbox when it cannot be picked', async () => {
    const { el, root } = await render();
    const picks = listen(el, 'acp-commit-pick');
    const toggles = listen(el, 'acp-change-toggle');
    const box = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-change-row__pick'));
    box.click();
    expect(picks).to.deep.equal([{ ids: ['src/b.js'], picked: true }]);
    expect(toggles).to.deep.equal([]);
    const readOnly = await render({ selectable: false });
    expect(readOnly.root.querySelector('.acp-change-row__pick')).to.equal(null);
  });
});
