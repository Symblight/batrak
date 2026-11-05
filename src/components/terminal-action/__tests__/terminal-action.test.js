import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../terminal-action.js';

describe('acp-terminal-action', () => {
  for (const [action, event, hint] of /** @type {const} */ ([
    ['new', 'acp-terminal-new', 'New terminal'],
    ['hide', 'acp-terminal-hide', 'Hide panel'],
  ])) {
    it(`asks to ${action === 'new' ? 'add a terminal' : 'hide the panel'}, with a hint`, async () => {
      // Arrange
      const el = await fixture(html`<acp-terminal-action action=${action}></acp-terminal-action>`);
      /** @type {string[]} */
      const heard = [];
      el.addEventListener(event, () => heard.push(event));
      const button = /** @type {HTMLElement} */ (el.shadowRoot.querySelector('md-icon-button'));

      // Act
      button.click();

      // Assert
      expect(heard).to.deep.equal([event]);
      expect(tooltipOf(button)).to.equal(hint);
      expect(el.shadowRoot.querySelector('[title]')).to.equal(null);
    });
  }
});
