import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import { shortcuts } from '../../../hooks/shortcuts/shortcuts.js';
import '../workspace-picker.js';

/** @typedef {import('../workspace-picker.js').AcpWorkspacePicker} AcpWorkspacePicker */
/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../../hooks/workspaces/types.js').WorkspaceStatus} WorkspaceStatus */

/** @param {string} id @param {string} name */
const ws = (id, name) => /** @type {Workspace} */ ({ id, name, folder: `/data/wt/${id}/app`, branch: `batrak/${id}` });

const LIST = [ws('w1', 'Fix login'), ws('w2', 'Add search')];

/**
 * @param {Partial<AcpWorkspacePicker>} props
 * @returns {Promise<{ el: AcpWorkspacePicker, root: ShadowRoot }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpWorkspacePicker} */ (await fixture(html`<acp-workspace-picker></acp-workspace-picker>`));
  Object.assign(el, { enabled: true, projectName: 'app', projectPath: '/work/app', workspaces: LIST, statuses: {}, currentId: 'w1', ...props });
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {ShadowRoot} root */
const menuOf = (root) => /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-workspace-picker__menu'));

/** @param {ShadowRoot} root @param {string} value */
const rowOf = (root, value) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (root.querySelector(`md-menu-item[value="${value}"]`));

/** @param {ShadowRoot} root */
const rowLabels = (root) => [...root.querySelectorAll('.acp-workspace-picker__row')].map((r) => r.getAttribute('aria-label'));

/**
 * Picks a row as md-menu reports it.
 * @param {ShadowRoot} root
 * @param {string} value
 */
function pick(root, value) {
  menuOf(root).dispatchEvent(new CustomEvent('select', { detail: { value, item: rowOf(root, value) } }));
}

/**
 * @param {Element} target
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function press(target, key, init = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init }));
}

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

describe('acp-workspace-picker', () => {
  it("closed: the shown workspace's name and status on a button that opens its menu", async () => {
    // Arrange
    const { el, root } = await render({ statuses: { w1: 'working' } });
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-picker__button'));

    // Act
    button.click();
    await el.updateComplete;

    // Assert
    expect(button.querySelector('.acp-workspace-picker__name')?.textContent?.trim()).to.equal('Fix login');
    expect(button.querySelector('acp-workspace-status')?.status).to.equal('working');
    expect(tooltipOf(button)).to.equal(shortcuts.labelled('Switch workspace', 'openWorkspaces'));
    expect(menuOf(root).open, 'the menu opens').to.equal(true);
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('without workspaces offers New workspace; without git a disabled icon says why', async () => {
    // Arrange
    const { el, root } = await render({ workspaces: [], currentId: null });
    const fired = record(el, 'acp-workspace-new');
    const add = /** @type {HTMLElement} */ (root.querySelector('md-icon-button'));
    const { root: noGit } = await render({ enabled: false, workspaces: [], currentId: null });
    const disabled = /** @type {HTMLElement & { disabled: boolean }} */ (noGit.querySelector('md-icon-button'));

    // Act
    add.click();

    // Assert
    expect(root.querySelector('md-menu'), 'no menu').to.equal(null);
    expect([tooltipOf(add), add.getAttribute('aria-label')]).to.deep.equal([shortcuts.labelled('New workspace', 'newWorkspace'), 'New workspace']);
    expect(fired).to.deep.equal([null]);
    expect(disabled.disabled).to.equal(true);
    expect(tooltipOf(noGit.getElementById('acp-workspace-picker-disabled'))).to.equal('Workspaces need a git repository');
  });

  it('lists Active, then Main, then New workspace, the shown one selected, each named with its status', async () => {
    // Arrange + Act
    const { root } = await render({ statuses: { w2: 'waiting', main: 'unread' } });

    // Assert
    const groups = [...root.querySelectorAll('md-menu-group')].map((g) => ({
      label: g.getAttribute('label'),
      rows: [...g.querySelectorAll('md-menu-item')].map((r) => r.getAttribute('aria-label')),
    }));
    expect(groups).to.deep.equal([
      { label: 'Active', rows: ['Fix login, idle', 'Add search, waiting for you'] },
      { label: 'Main', rows: ['Main, unread'] },
    ]);
    expect(['w1', 'w2', 'main'].map((id) => rowOf(root, id).selected)).to.deep.equal([true, false, false]);
    expect(rowOf(root, 'new-workspace')?.textContent?.trim()).to.match(/^New workspace/);
  });

  it("shows each numbered row's shortcut, and New workspace's", async () => {
    // Arrange + Act: w2 has no number (past 9)
    const { root } = await render({ numbers: { main: 1, w1: 2 } });

    // Assert
    const chips = ['w1', 'w2', 'main'].map((id) => rowOf(root, id).querySelector('acp-shortcut')?.shortcut ?? null);
    expect(chips).to.deep.equal(['workspace2', null, 'workspace1']);
    expect(rowOf(root, 'new-workspace').textContent?.replace(/\s+/g, ' ').trim()).to.equal(`New workspace ${shortcuts.hint('newWorkspace')}`);
  });

  it('fires the picked workspace, or New workspace', async () => {
    // Arrange
    const { el, root } = await render();
    const picked = record(el, 'acp-workspace-select');
    const created = record(el, 'acp-workspace-new');

    // Act
    pick(root, 'w2');
    pick(root, 'main');
    pick(root, 'new-workspace');

    // Assert
    expect(picked).to.deep.equal([{ id: 'w2' }, { id: 'main' }]);
    expect(created).to.deep.equal([null]);
  });

  it("opens a row's own menu from its ⋯ (not picking it) or Shift+F10", async () => {
    // Arrange
    const { el, root } = await render();
    const picked = record(el, 'acp-workspace-select');
    const menu = /** @type {HTMLElementTagNameMap['acp-workspace-menu']} */ (root.querySelector('acp-workspace-menu'));
    menuOf(root).open = true;
    await menuOf(root).updateComplete;

    // Act
    /** @type {HTMLElement} */ (rowOf(root, 'main').querySelector('.acp-workspace-picker__more')).click();
    await el.updateComplete;
    const fromButton = [menu.workspace, menu.mainFolder];
    rowOf(root, 'w2').focusInteractive();
    press(rowOf(root, 'w2'), 'F10', { shiftKey: true });
    await el.updateComplete;

    // Assert
    expect(fromButton, "Main's ⋯").to.deep.equal([null, '/work/app']);
    expect(menu.workspace?.id, 'Shift+F10 on a row').to.equal('w2');
    expect(picked, 'a click on ⋯ picks nothing').to.deep.equal([]);
  });

  it('renames a row in place: F2, Enter saves, Escape cancels, empty is refused', async () => {
    // Arrange
    const { el, root } = await render();
    const renamed = record(el, 'acp-workspace-rename');
    menuOf(root).open = true;
    await menuOf(root).updateComplete;
    const field = () => /** @type {HTMLInputElement | null} */ (root.querySelector('.acp-workspace-picker__rename'));
    /** @param {string} value @param {string} key */
    const type = async (value, key) => {
      if (field() === null) {
        rowOf(root, 'w1').focusInteractive();
        press(rowOf(root, 'w1'), 'F2');
        await el.updateComplete;
      }
      const input = /** @type {HTMLInputElement} */ (field());
      input.value = value;
      press(input, key);
      await el.updateComplete;
    };

    // Act
    await type('  ', 'Enter');
    const stillEditing = field() !== null;
    await type('Ignored', 'Escape');
    await type('  Fix the login  ', 'Enter');

    // Assert
    expect(stillEditing, 'empty is refused').to.equal(true);
    expect(renamed).to.deep.equal([{ id: 'w1', name: 'Fix the login' }]);
    expect(field()).to.equal(null);
  });

  it("starts the inline rename of the row its menu's Rename was picked for", async () => {
    // Arrange
    const { el, root } = await render();

    // Act
    root.querySelector('acp-workspace-menu')?.dispatchEvent(new CustomEvent('acp-workspace-rename-start', { detail: { id: 'w2' }, bubbles: true, composed: true }));
    await el.updateComplete;

    // Assert
    expect(/** @type {HTMLInputElement | null} */ (rowOf(root, 'w2').querySelector('.acp-workspace-picker__rename'))?.value).to.equal('Add search');
  });

  it('badges the button with how many other workspaces wait, Main included', async () => {
    /** @type {[Record<string, WorkspaceStatus>, string | null][]} */
    const cases = [
      [{}, null],
      [{ w1: 'waiting' }, null],
      [{ w2: 'waiting', main: 'waiting', w1: 'waiting' }, '2 waiting'],
      [{ w2: 'waiting' }, '1 waiting'],
    ];
    for (const [statuses, badge] of cases) {
      // Arrange + Act
      const { root } = await render({ statuses });

      // Assert
      expect(root.querySelector('.acp-workspace-picker__badge')?.textContent?.trim() ?? null, JSON.stringify(statuses)).to.equal(badge);
    }
  });

  it('from 8 workspaces filters the list from a field on top', async () => {
    // Arrange
    const many = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'].map((name, i) => ws(`w${i}`, name));
    const { el, root } = await render({ workspaces: many, currentId: 'w0' });
    const { root: few } = await render();
    const filter = /** @type {HTMLInputElement} */ (root.querySelector('.acp-workspace-picker__filter'));

    // Act
    filter.value = 'eta';
    filter.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await el.updateComplete;

    // Assert
    expect(few.querySelector('.acp-workspace-picker__filter'), 'no filter under 8').to.equal(null);
    expect(rowLabels(root)).to.deep.equal(['Beta, idle', 'Zeta, idle', 'Eta, idle', 'Theta, idle']);
  });
});
