import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../terminal-find.js';

/** @typedef {import('../terminal-find.js').AcpTerminalFind} AcpTerminalFind */

describe('acp-terminal-find', () => {
  it('asks to move between matches and to close, by button and by key', async () => {
    // Arrange
    const el = /** @type {AcpTerminalFind} */ (await fixture(html`<acp-terminal-find query="x"></acp-terminal-find>`));
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-terminal-find-step', (e) => asked.push(/** @type {CustomEvent} */ (e).detail.direction));
    el.addEventListener('acp-terminal-find-close', () => asked.push('close'));
    const button = (/** @type {string} */ label) => /** @type {HTMLElement} */ (el.shadowRoot?.querySelector(`[aria-label="${label}"]`));
    const press = (/** @type {KeyboardEventInit} */ key) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, ...key }));
    // Act
    button('Previous match').click();
    button('Next match').click();
    button('Close').click();
    press({ key: 'Enter' });
    press({ key: 'Enter', shiftKey: true });
    press({ key: 'Escape' });
    press({ key: 'a' });
    // Assert
    expect(asked).to.deep.equal(['previous', 'next', 'close', 'next', 'previous', 'close']);
    expect(tooltipOf(button('Next match'))).to.equal('Next match');
  });

  it('shows how many matches, nothing until there is something to say', async () => {
    const cases = [
      // [query, invalid, result, shown]
      ['', false, { index: -1, total: 0 }, ''],
      ['x', true, { index: -1, total: 0 }, ''],
      ['x', false, null, ''],
      ['x', false, { index: -1, total: 0 }, 'No results'],
      ['x', false, { index: 1, total: 3 }, '2 of 3'],
    ];
    for (const [query, invalid, result, shown] of cases) {
      // Act
      const el = /** @type {AcpTerminalFind} */ (await fixture(html`<acp-terminal-find .query=${query} .invalid=${invalid} .result=${result}></acp-terminal-find>`));
      // Assert
      expect(el.shadowRoot?.querySelector('.acp-terminal-find__count')?.textContent, JSON.stringify([query, invalid, result])).to.equal(shown);
    }
  });
});
