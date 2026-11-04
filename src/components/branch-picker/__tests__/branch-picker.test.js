import { expect, fixture, html } from '../../../../test/fixture.js';
import '../branch-picker.js';

/** @typedef {import('../branch-picker.js').AcpBranchPicker} AcpBranchPicker */
/** @typedef {import('../../../hooks/git/types.js').BranchList} BranchList */

/** @type {BranchList} */
const LIST = {
  local: ['main', 'audit'],
  remotes: [
    { remote: 'origin', branches: ['origin/main', 'origin/terminal-tab'] },
    { remote: 'fork', branches: ['fork/main'] },
  ],
  default: 'origin/main',
};

/**
 * @param {Partial<AcpBranchPicker>} [props]
 * @returns {Promise<{ el: AcpBranchPicker, root: ShadowRoot }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpBranchPicker} */ (await fixture(html`<acp-branch-picker></acp-branch-picker>`));
  Object.assign(el, { list: LIST, value: 'origin/main', ...props });
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** The menu's groups and their rows' text, as read. @param {ShadowRoot} root */
const groups = (root) =>
  [...root.querySelectorAll('md-menu-group')].map((g) => ({
    label: g.getAttribute('label'),
    rows: [...g.querySelectorAll(':scope > md-menu-item')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
  }));

/**
 * @param {EventTarget} el
 * @param {string} type
 */
function record(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

describe('acp-branch-picker', () => {
  it('names the picked branch on its button and lists Remote by remote, then Local, the default marked and the picked one selected', async () => {
    // Arrange + Act
    const { root } = await render();

    // Assert
    expect(root.querySelector('.acp-branch-picker__button')?.textContent?.replace(/\s+/g, ' ').trim()).to.equal('From origin/main');
    expect(groups(root)).to.deep.equal([
      { label: 'Remote', rows: [] },
      { label: 'origin', rows: ['main default', 'terminal-tab'] },
      { label: 'fork', rows: ['main'] },
      { label: 'Local', rows: ['main', 'audit'] },
    ]);
    const selected = [...root.querySelectorAll('md-menu-item')].filter((r) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (r).selected);
    expect(selected.map((r) => r.getAttribute('value'))).to.deep.equal(['origin/main']);
  });

  it('fires the picked branch', async () => {
    // Arrange
    const { el, root } = await render();
    const picked = record(el, 'acp-branch-pick');
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));

    // Act
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: 'audit' } }));

    // Assert
    expect(picked).to.deep.equal([{ branch: 'audit' }]);
  });

  it('opens its menu once its branches are loaded, with a spinner on the button meanwhile', async () => {
    // Arrange
    /** @type {() => void} */
    let loaded = () => {};
    const { el, root } = await render({ load: () => new Promise((resolve) => (loaded = () => resolve(undefined))) });
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('md-menu'));
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-branch-picker__button'));

    // Act
    button.click();
    await el.updateComplete;
    const loading = [button.querySelector('md-progress-circular') !== null, menu.open];
    loaded();
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    // Assert
    expect(loading, 'a spinner, no menu yet').to.deep.equal([true, false]);
    expect([button.querySelector('md-progress-circular'), menu.open], 'loaded').to.deep.equal([null, true]);
  });
});
