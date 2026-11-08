import { expect, fixture, html } from '../../../../test/fixture.js';
import '../collapsible-text.js';

/** @typedef {import('../collapsible-text.js').AcpCollapsibleText} AcpCollapsibleText */

/** @param {number} lines */
const textOf = (lines) => Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');

/** @param {AcpCollapsibleText} el @returns The Show more / Show less button, when there is one. */
const toggleOf = (el) => /** @type {HTMLElement | null} */ (el.shadowRoot?.querySelector('.acp-collapsible-text__toggle') ?? null);

/** @param {AcpCollapsibleText} el */
const settled = async (el) => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await el.updateComplete;
};

describe('acp-collapsible-text', () => {
  it('folds a long text, which Show more unfolds and Show less folds again; a short one stays as it is', async () => {
    for (const lines of [2, 40]) {
      // Arrange
      const el = /** @type {AcpCollapsibleText} */ (
        await fixture(html`<acp-collapsible-text><span style="white-space: pre-line">${textOf(lines)}</span></acp-collapsible-text>`)
      );
      await settled(el);
      const folds = lines > 2;

      // Assert: folded or not, with the button only when folded
      const text = /** @type {HTMLElement} */ (el.querySelector('span'));
      const shown = () => el.getBoundingClientRect().height >= text.getBoundingClientRect().height - 1;
      expect(shown(), `${lines} lines all shown`).to.equal(!folds);
      expect(toggleOf(el)?.textContent?.trim() ?? null, `${lines} lines`).to.equal(folds ? 'Show more' : null);
      if (!folds) continue;
      const folded = el.getBoundingClientRect().height;

      // Act
      toggleOf(el)?.click();
      await settled(el);

      // Assert: unfolded
      expect(toggleOf(el)?.textContent?.trim()).to.equal('Show less');
      expect(toggleOf(el)?.getAttribute('aria-expanded')).to.equal('true');
      expect(el.getBoundingClientRect().height, 'taller unfolded').to.be.above(folded);

      // Act
      toggleOf(el)?.click();
      await settled(el);

      // Assert: folded again
      expect(toggleOf(el)?.textContent?.trim()).to.equal('Show more');
      expect(el.getBoundingClientRect().height, 'folded again').to.be.closeTo(folded, 1);
    }
  });
});
