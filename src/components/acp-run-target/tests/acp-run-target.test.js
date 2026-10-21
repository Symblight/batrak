import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-run-target.js';

/** @typedef {import('../../../models/types.js').ComposerState} ComposerState */

/** @type {ComposerState} */
const DRAFT = {
  agentId: 'a',
  configOptions: [],
  chosen: {},
  runTarget: { kind: 'local', branch: null },
  started: false,
};

/** @param {Element} el */
function localDescription(el) {
  const item = /** @type {ShadowRoot} */ (el.shadowRoot).querySelector('md-menu-item[value="local"]');
  return item?.querySelector('[slot="supporting-text"]')?.textContent?.trim();
}

describe('acp-run-target', () => {
  it('describes Local as the workspace while no other local session runs', async () => {
    const el = await fixture(html`<acp-run-target .composer=${DRAFT}></acp-run-target>`);
    expect(localDescription(el)).to.equal('Runs directly in this workspace');
  });

  it('says the checkout is shared, and how turns share it', async () => {
    const el = await fixture(html`<acp-run-target .composer=${DRAFT} .localShared=${1}></acp-run-target>`);
    expect(localDescription(el)).to.equal('Shared with 1 running session. Turns wait for each other');
    el.localShared = 2;
    el.localTurns = 'parallel';
    await el.updateComplete;
    expect(localDescription(el)).to.equal('Shared with 2 running sessions. Turns run at once');
    const item = /** @type {ShadowRoot} */ (el.shadowRoot).querySelector('md-menu-item[value="local"]');
    expect(item?.hasAttribute('disabled')).to.equal(false);
  });
});
