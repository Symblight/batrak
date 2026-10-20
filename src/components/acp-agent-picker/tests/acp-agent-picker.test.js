import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-agent-picker.js';

/** @typedef {import('../../../models/types.js').ComposerState} ComposerState */

/** @type {ComposerState} */
const NO_AGENT = {
  agentId: null,
  configOptions: [],
  chosen: {},
  usage: null,
  runTarget: { kind: 'local', branch: null },
  started: false,
};

describe('acp-agent-picker', () => {
  it('offers only to add an agent while none is configured', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-agent-picker__button')?.textContent).to.contain('Add agent');
    const items = [...root.querySelectorAll('md-menu-item')];
    expect(items.map((i) => i.dataset.action)).to.deep.equal(['add-agent']);
    expect(root.querySelector('md-menu-group')).to.equal(null);
  });

  it('opens its menu from the button once the agents arrive', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const agent = { id: 'a', name: 'A', glyph: 'A', configOptions: [] };
    el.agents = [agent];
    el.agent = agent;
    el.composer = { ...NO_AGENT, agentId: 'a' };
    await el.updateComplete;
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement & { open: boolean }} */ (root.querySelector('md-menu'));
    /** @type {HTMLElement} */ (root.querySelector('.acp-agent-picker__button')).click();
    expect(menu.open).to.equal(true);
  });

  it('opens the agents file from its only item', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item'));
    let opened = false;
    el.addEventListener('acp-agents-file-open', () => (opened = true));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: '', item } }));
    expect(opened).to.equal(true);
  });
});
