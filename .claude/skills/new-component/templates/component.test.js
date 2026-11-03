import { expect, fixture, html } from '../../../../test/fixture.js';
import '../NAME.js';

/** @typedef {import('../NAME.js').ClassName} ClassName */

describe('acp-NAME', () => {
  // Replace with the first user-visible behavior; see it fail before implementing it.
  it('TODO: shows its value', async () => {
    // Arrange
    const el = /** @type {ClassName} */ (await fixture(html`<acp-NAME .value=${'hello'}></acp-NAME>`));

    // Act
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);

    // Assert
    expect(root.querySelector('.acp-NAME__label')?.textContent).to.equal('hello');
  });
});
