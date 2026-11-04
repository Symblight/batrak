import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../run-target.js';

/** @typedef {import('../run-target.js').AcpRunTarget} AcpRunTarget */
/** @typedef {import('../../../hooks/git/types.js').BranchList} BranchList */

/** @type {BranchList} */
const BRANCHES = { local: ['main', 'dev'], remotes: [], default: null };

/**
 * @param {Partial<AcpRunTarget>} [props]
 * @returns {Promise<{ el: AcpRunTarget, root: ShadowRoot }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpRunTarget} */ (await fixture(html`<acp-run-target></acp-run-target>`));
  Object.assign(el, { target: { kind: 'local' }, workspaceName: null, branches: BRANCHES, base: 'main', ...props });
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {ShadowRoot} root */
const menuOf = (root) => /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-run-target__menu'));

/** @param {ShadowRoot} root @param {string} value */
const rowOf = (root, value) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (root.querySelector(`md-menu-item[value="${value}"]`));

/** @param {Element | null | undefined} el */
const textOf = (el) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

/**
 * @param {EventTarget} el
 * @param {string} type
 * @returns {unknown[]} Details of `type` events fired from now on.
 */
function record(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

describe('acp-run-target', () => {
  it("offers This workspace (by name) only in a worktree workspace, besides New worktree (where the project can have workspaces) and Local, the current place on its button and picked", async () => {
    const cases = [
      // [props, rows, button, picked]
      [{ workspaceName: 'Fix login', target: { kind: 'workspace' } }, ['workspace', 'worktree', 'local'], 'Fix login', 'workspace'],
      [{ workspaceName: null, target: { kind: 'local' } }, ['worktree', 'local'], 'Local', 'local'],
      [{ workspaceName: null, target: { kind: 'worktree', base: null } }, ['worktree', 'local'], 'New worktree', 'worktree'],
      [{ workspaceName: null, target: { kind: 'local' }, worktrees: false }, ['local'], 'Local', 'local'],
    ];
    for (const [props, rows, button, picked] of cases) {
      // Arrange + Act
      const { root } = await render(/** @type {Partial<AcpRunTarget>} */ (props));

      // Assert
      const items = [...root.querySelectorAll('md-menu-item')];
      expect(items.map((i) => i.getAttribute('value')), String(button)).to.deep.equal(rows);
      expect(items.filter((i) => i.selected).map((i) => i.getAttribute('value')), `${button}: picked`).to.deep.equal([picked]);
      const kindButton = root.querySelector('.acp-run-target__button');
      expect(textOf(kindButton), `${button}: its button`).to.equal(button);
      expect(tooltipOf(kindButton), 'its hint').to.equal('Where the new chat runs');
    }
    const { root } = await render({ workspaceName: 'Fix login', target: { kind: 'workspace' } });
    expect(textOf(rowOf(root, 'workspace')), 'the row names it').to.equal('This workspace Fix login');
  });

  it('fires the picked place; New worktree starts from its base picker, whose pick fires it with that base', async () => {
    // Arrange
    const load = async () => {};
    const { el, root } = await render({ workspaceName: 'Fix login', target: { kind: 'workspace' } });
    const changes = record(el, 'acp-run-target-change');
    const noBase = root.querySelector('acp-branch-picker');

    // Act: pick each place, as md-menu reports it
    for (const value of ['worktree', 'local', 'workspace']) {
      menuOf(root).dispatchEvent(new CustomEvent('select', { detail: { value, item: rowOf(root, value) } }));
    }
    Object.assign(el, { target: { kind: 'worktree', base: null }, base: 'main', loadBranches: load });
    await el.updateComplete;
    const picker = /** @type {HTMLElementTagNameMap['acp-branch-picker']} */ (root.querySelector('acp-branch-picker'));
    const escaped = record(el, 'acp-branch-pick');
    picker.dispatchEvent(new CustomEvent('acp-branch-pick', { detail: { branch: 'dev' }, bubbles: true, composed: true }));

    // Assert
    expect(noBase, 'no base outside New worktree').to.equal(null);
    expect([picker.list, picker.value, picker.load], 'the base picker').to.deep.equal([BRANCHES, 'main', load]);
    expect(changes).to.deep.equal([
      { target: { kind: 'worktree', base: null } },
      { target: { kind: 'local' } },
      { target: { kind: 'workspace' } },
      { target: { kind: 'worktree', base: 'dev' } },
    ]);
    expect(escaped, 'the base pick stays inside').to.deep.equal([]);
  });
});
