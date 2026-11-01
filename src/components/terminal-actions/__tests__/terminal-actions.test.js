import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../terminal-actions.js';

describe('acp-terminal-actions', () => {
  it('asks for a new terminal with +, and to hide the panel with −, each with a hint', async () => {
    // Arrange
    const el = await fixture(html`<acp-terminal-actions></acp-terminal-actions>`);
    /** @type {string[]} */
    const heard = [];
    for (const type of ['acp-terminal-new', 'acp-terminal-hide']) el.addEventListener(type, () => heard.push(type));
    const buttons = /** @type {HTMLElement[]} */ ([...el.shadowRoot.querySelectorAll('md-icon-button')]);

    // Act
    for (const button of buttons) button.click();

    // Assert
    expect(heard).to.deep.equal(['acp-terminal-new', 'acp-terminal-hide']);
    expect(buttons.map((b) => tooltipOf(b))).to.deep.equal(['New terminal', 'Hide panel']);
    expect(el.shadowRoot.querySelector('[title]')).to.equal(null);
  });
});
