import { expect, fixture, html } from '../../../../test/fixture.js';
import '../quick-open.js';

/** @typedef {import('../quick-open.js').AcpQuickOpen} AcpQuickOpen */

const FILES = [
  { path: 'src/a.js', name: 'a.js', indices: [], isDir: false },
  { path: 'src/b.js', name: 'b.js', indices: [], isDir: false },
];

/** @param {Partial<AcpQuickOpen>} [props] */
async function open(props = {}) {
  const el = /** @type {AcpQuickOpen} */ (await fixture(html`<acp-quick-open></acp-quick-open>`));
  Object.assign(el, { hasProject: true, ...props });
  await el.show();
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
  return { el, root, input };
}

describe('acp-quick-open', () => {
  it('is a combobox over its list: expanded with files listed, the selected option active', async () => {
    // Arrange
    const { el, root, input } = await open();
    // Assert: nothing to choose from yet
    expect(input.getAttribute('role')).to.equal('combobox');
    expect(input.getAttribute('aria-expanded')).to.equal('false');
    expect(input.hasAttribute('aria-controls')).to.equal(false);
    expect(input.hasAttribute('aria-activedescendant')).to.equal(false);
    // Act
    el.files = FILES;
    await el.updateComplete;
    // Assert
    const list = /** @type {HTMLElement} */ (root.querySelector('[role="listbox"]'));
    const options = [...root.querySelectorAll('[role="option"]')];
    expect(input.getAttribute('aria-expanded')).to.equal('true');
    expect(input.getAttribute('aria-controls')).to.equal(list.id);
    expect(input.getAttribute('aria-activedescendant')).to.equal(options[0].id);
    expect(new Set(options.map((o) => o.id)).size).to.equal(2);

    // Act
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await el.updateComplete;
    // Assert
    expect(input.getAttribute('aria-activedescendant')).to.equal(options[1].id);
    expect(options[1].getAttribute('aria-selected')).to.equal('true');
  });
});
