import { expect, fixture, html } from '../../../../test/fixture.js';
import '../compare-chip.js';

/** @param {Partial<HTMLElementTagNameMap['acp-compare-chip']>} props */
async function render(props) {
  const el = /** @type {HTMLElementTagNameMap['acp-compare-chip']} */ (await fixture(html`<acp-compare-chip></acp-compare-chip>`));
  Object.assign(el, props);
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root };
}

describe('acp-compare-chip', () => {
  it('names the branch as picked, and removing it asks for local changes', async () => {
    // Arrange
    const { el, root } = await render({ target: 'origin/main' });
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-compare-pick', (e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    const chip = /** @type {HTMLElement} */ (root.querySelector('md-input-chip'));
    // Act
    chip.dispatchEvent(new CustomEvent('remove'));
    // Assert
    expect(chip.textContent).to.contain('Diff to origin/main');
    expect(asked).to.deep.equal([{ branch: null }]);
  });

  it('says why a refresh failed, only then', async () => {
    // Arrange
    const { el, root } = await render({ target: 'main' });
    const said = () => root.querySelector('[role="status"]')?.textContent?.trim();
    const before = said();
    // Act
    el.refreshError = 'git timed out after 10s';
    await el.updateComplete;
    // Assert
    expect(before).to.equal(undefined);
    expect(said()).to.equal('Couldn’t refresh: git timed out after 10s');
  });

  it('a click on the chip’s body leaves it unselected', async () => {
    // Arrange
    const { el, root } = await render({ target: 'main' });
    const chip = /** @type {HTMLElementTagNameMap['md-input-chip']} */ (root.querySelector('md-input-chip'));
    // Act
    chip.selected = true; // what the chip does to itself on a click
    el.requestUpdate();
    await el.updateComplete;
    // Assert
    expect(chip.selected).to.equal(false);
  });
});
