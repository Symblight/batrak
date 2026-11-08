import { expect, fixture, html } from '../../../../test/fixture.js';
import '../collapsible-text.js';

/** @typedef {import('../collapsible-text.js').AcpCollapsibleText} AcpCollapsibleText */

/** @param {number} lines */
const textOf = (lines) => Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');

/** @param {AcpCollapsibleText} el */
const boxOf = (el) => /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-collapsible-text__box'));

/** @param {AcpCollapsibleText} el */
const settled = async (el) => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await el.updateComplete;
};

describe('acp-collapsible-text', () => {
  it('folds a long text, which a click or a key unfolds; a short one stays as it is', async () => {
    const cases = [
      { lines: 2, folds: false, open: null },
      { lines: 40, folds: true, open: 'click' },
      { lines: 40, folds: true, open: 'Enter' },
    ];
    for (const { lines, folds, open } of cases) {
      // Arrange
      const el = /** @type {AcpCollapsibleText} */ (
        await fixture(html`<acp-collapsible-text><span style="white-space: pre-line">${textOf(lines)}</span></acp-collapsible-text>`)
      );
      await settled(el);
      const box = boxOf(el);

      // Assert: folded or not
      expect(box.getAttribute('aria-expanded'), `${lines} lines`).to.equal(folds ? 'false' : null);
      const text = /** @type {HTMLElement} */ (el.querySelector('span'));
      const shown = () => el.getBoundingClientRect().height >= text.getBoundingClientRect().height - 1;
      expect(shown(), `${lines} lines all shown`).to.equal(!folds);
      if (!open) continue;
      const folded = el.getBoundingClientRect().height;

      // Act
      if (open === 'click') box.click();
      else box.dispatchEvent(new KeyboardEvent('keydown', { key: open, bubbles: true }));
      await settled(el);

      // Assert: unfolded
      expect(box.getAttribute('aria-expanded'), open).to.equal('true');
      expect(el.getBoundingClientRect().height, 'taller unfolded').to.be.above(folded);
    }
  });
});
