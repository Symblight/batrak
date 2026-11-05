import { expect, fixture, html } from '../../../../test/fixture.js';
import '../subagent-bar.js';

/** @typedef {import('../../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {HTMLElementTagNameMap['acp-subagent-bar']} AcpSubagentBar */

/** @param {Partial<Subagent>} [fields] @returns {Subagent} */
const subagent = (fields = {}) => ({
  id: 'c1',
  title: 'Find usages',
  description: 'Explore',
  state: 'running',
  stopReason: null,
  cancellable: true,
  announcedAt: '2026-11-03T11:57:00.000Z',
  ...fields,
});

/** @param {Subagent} value */
async function render(value) {
  /** @type {AcpSubagentBar} */
  const el = await fixture(html`<acp-subagent-bar .subagent=${value} .chatTitle=${'Fix the menu'}></acp-subagent-bar>`);
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const stop = () => /** @type {HTMLElement | null} */ (root.querySelector('[aria-label="Stop subagent"]'));
  return { el, root, stop };
}

describe('acp-subagent-bar', () => {
  it('names the subagent and its chat, offering Stop only while it runs and may be stopped', async () => {
    const cases = [
      { fields: {}, stop: true, why: 'running, cancellable' },
      { fields: { cancellable: false }, stop: false, why: 'running, not cancellable' },
      { fields: { state: /** @type {const} */ ('requires_action') }, stop: true, why: 'waiting' },
      { fields: { state: /** @type {const} */ ('idle'), stopReason: 'end_turn' }, stop: false, why: 'done' },
    ];
    for (const c of cases) {
      // Arrange + Act
      const { root, stop } = await render(subagent(c.fields));
      // Assert
      expect(root.textContent?.replace(/\s+/g, ' '), c.why).to.include('Explore · Find usages').and.include('Fix the menu');
      expect(Boolean(stop()), c.why).to.equal(c.stop);
    }
  });

  it('asks to go back to the chat, or to stop the subagent', async () => {
    // Arrange
    const { el, root, stop } = await render(subagent());
    /** @type {[string, unknown][]} */
    const asked = [];
    for (const type of ['acp-subagent-close', 'acp-subagent-stop']) el.addEventListener(type, (e) => asked.push([type, /** @type {CustomEvent} */ (e).detail]));
    // Act
    /** @type {HTMLElement} */ (root.querySelector('[aria-label="Back to chat"]')).click();
    stop()?.click();
    // Assert
    expect(asked).to.deep.equal([
      ['acp-subagent-close', null],
      ['acp-subagent-stop', { subagentId: 'c1' }],
    ]);
  });
});
