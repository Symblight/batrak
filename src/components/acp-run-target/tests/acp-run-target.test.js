import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
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

  it("notes network and files outside the workspace for a full-access mode, by its risk, not its name", async () => {
    /** @param {import('../../../models/types.js').ConfigOptionValue[]} options @param {string} current */
    const withMode = (options, current) => ({
      ...DRAFT,
      configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: /** @type {const} */ ('select'), currentValue: current, options }],
    });
    const note = (/** @type {Element} */ el) => /** @type {ShadowRoot} */ (el.shadowRoot).querySelector('.acp-run-target__note');
    const bypass = await fixture(html`<acp-run-target .composer=${withMode([{ value: 'bypassPermissions', name: 'Bypass', risk: 'full' }], 'bypassPermissions')}></acp-run-target>`);
    expect(note(bypass)?.textContent).to.contain('Network and files outside the workspace');
    const untagged = await fixture(html`<acp-run-target .composer=${withMode([{ value: 'full', name: 'Full' }], 'full')}></acp-run-target>`);
    expect(note(untagged), 'a name alone says nothing').to.equal(null);
  });

  it('explains its buttons and the fixed target in tooltips, not titles', async () => {
    const el = await fixture(html`<acp-run-target .composer=${{ ...DRAFT, runTarget: { kind: 'worktree', branch: 'main' } }}></acp-run-target>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('#acp-run-target-kind'))).to.equal('Where the agent runs');
    expect(tooltipOf(root.querySelector('#acp-run-target-branch'))).to.equal('Branch the worktree starts from');
    expect(root.querySelector('[title]')).to.equal(null);
    el.composer = { ...DRAFT, runTarget: { kind: 'worktree', branch: 'main' }, started: true };
    await el.updateComplete;
    const fixed = [...root.querySelectorAll('.acp-run-target__fixed')].map(tooltipOf);
    expect(fixed).to.deep.equal(['Fixed for this session', 'Fixed for this session']);
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
