import { expect, fixture, html } from '../../../../test/fixture.js';
import '../marked-text.js';

describe('acp-marked-text', () => {
  it('marks the given ranges and leaves the rest as plain text', async () => {
    /** @type {[string, [number, number][], string[], string][]} */
    const cases = [
      ['Claude Code', [[0, 2], [7, 9]], ['Cl', 'Co'], 'two ranges'],
      ['Claude Code', [], [], 'none'],
      ['Codex', [[0, 5]], ['Codex'], 'all of it'],
    ];
    for (const [text, ranges, marked, why] of cases) {
      const el = /** @type {import('../marked-text.js').AcpMarkedText} */ (await fixture(html`<acp-marked-text .text=${text} .ranges=${ranges}></acp-marked-text>`));
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      expect([...root.querySelectorAll('mark')].map((m) => m.textContent), why).to.deep.equal(marked);
      expect(root.textContent, `${why}: the text itself is unchanged`).to.equal(text);
    }
  });
});
