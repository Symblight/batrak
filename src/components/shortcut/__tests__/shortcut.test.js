import { expect, fixture, html } from '../../../../test/fixture.js';
import { shortcuts } from '../../../hooks/shortcuts/shortcuts.js';
import '../shortcut.js';

/**
 * The text the chip shows: its own, or what is slotted into it.
 * @param {HTMLElement} el
 */
function shown(el) {
  const key = el.shadowRoot?.querySelector('kbd');
  const slot = key?.querySelector('slot');
  const slotted = slot ? slot.assignedNodes().map((n) => n.textContent).join('') : '';
  return `${[...(key?.childNodes ?? [])].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('')}${slotted}`.trim();
}

describe('acp-shortcut', () => {
  it('shows a shortcut’s hint, a group’s, or else its slotted text, as one key', async () => {
    /** @type {[import('lit').TemplateResult, string, string][]} */
    const cases = [
      // [element, text, why]
      [html`<acp-shortcut .shortcut=${'quickOpen'}></acp-shortcut>`, shortcuts.hint('quickOpen'), 'one id'],
      [html`<acp-shortcut .shortcut=${['matchCase', 'wholeWord', 'regex']}></acp-shortcut>`, shortcuts.group(['matchCase', 'wholeWord', 'regex']), 'a group'],
      [html`<acp-shortcut>Esc</acp-shortcut>`, 'Esc', 'slotted'],
    ];
    for (const [template, text, why] of cases) {
      // Arrange + Act
      const el = /** @type {HTMLElement} */ (await fixture(template));
      // Assert
      expect(shown(el), why).to.equal(text);
      expect(el.shadowRoot?.querySelectorAll('kbd').length, `${why}: one key`).to.equal(1);
    }
  });
});
