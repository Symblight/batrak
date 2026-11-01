import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../agent-picker.js';

/** @typedef {import('../../../hooks/composer/types.js').ComposerState} ComposerState */

/** @type {ComposerState} */
const NO_AGENT = {
  agentId: null,
  configOptions: [],
  chosen: {},
  runTarget: { kind: 'local', branch: null },
  started: false,
};

describe('acp-agent-picker', () => {
  it('offers only to add an agent while none is configured', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-agent-picker__button')?.textContent).to.contain('Add agent');
    const items = [...root.querySelectorAll('md-menu-item')];
    expect(items.map((i) => i.dataset.action)).to.deep.equal(['add-agent', 'manage-agents']);
    expect(root.querySelector('md-menu-group')).to.equal(null);
    expect(tooltipOf(root.querySelector('#acp-agent-picker-button'))).to.equal('Add an ACP agent');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
  });

  it('opens its menu from the button once the agents arrive', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const agent = { id: 'a', name: 'A', configOptions: [] };
    el.agents = [agent];
    el.agent = agent;
    el.composer = { ...NO_AGENT, agentId: 'a' };
    await el.updateComplete;
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement & { open: boolean }} */ (root.querySelector('md-menu'));
    /** @type {HTMLElement} */ (root.querySelector('.acp-agent-picker__button')).click();
    expect(menu.open).to.equal(true);
  });

  it('asks to manage the agents', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[data-action="manage-agents"]'));
    expect(item.textContent?.trim()).to.equal('Manage agents…');
    let asked = false;
    el.addEventListener('acp-agents-manage', () => (asked = true));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: '', item } }));
    expect(asked).to.equal(true);
  });

  it('asks to add an agent from its first item', async () => {
    const el = await fixture(html`<acp-agent-picker .composer=${NO_AGENT} .agents=${[]} .agent=${null}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item'));
    let opened = false;
    el.addEventListener('acp-agent-add-open', () => (opened = true));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: '', item } }));
    expect(opened).to.equal(true);
  });

  it('offers no agent the user turned off', async () => {
    const a = { id: 'a', name: 'A', configOptions: [] };
    const b = { id: 'b', name: 'B', configOptions: [], off: true };
    const composer = { ...NO_AGENT, agentId: 'a' };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[a, b]} .agent=${a}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const offered = [...root.querySelectorAll('md-menu-group[label="Agent"] > md-menu-item')].map((i) => i.getAttribute('value'));
    expect(offered).to.deep.equal(['a']);
  });

  it('says which agent needs a sign-in, and still offers it', async () => {
    const a = { id: 'a', name: 'A', configOptions: [] };
    const b = { id: 'b', name: 'B', configOptions: [], signIn: true };
    const composer = { ...NO_AGENT, agentId: 'a' };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[a, b]} .agent=${a}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-group[label="Agent"] > md-menu-item[value="b"]'));
    expect(item.querySelector('[slot="supporting-text"]')?.textContent?.trim()).to.equal('Needs sign-in');
  });

  it("says when a started session's agent is off", async () => {
    const agent = { id: 'b', name: 'B', off: true };
    const composer = { ...NO_AGENT, agentId: 'b', started: true };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[]} .agent=${agent}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-agent-picker__agent')?.textContent?.trim()).to.equal('B (off)');
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[disabled]'));
    expect(item.querySelector('[slot="supporting-text"]')?.textContent?.trim()).to.equal('Turned off');
  });

  it('lists the offered agents with no submenus, the composer\'s selected', async () => {
    const model = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [{ value: 'opus', name: 'Opus' }],
    };
    const a = { id: 'a', name: 'A', configOptions: [model] };
    const b = { id: 'b', name: 'B', configOptions: [] };
    const composer = { ...NO_AGENT, agentId: 'a', configOptions: [model] };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[a, b]} .agent=${a}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('md-menu md-menu')).to.equal(null);
    const items = [...root.querySelectorAll('md-menu-group[label="Agent"] > md-menu-item')];
    expect(items.map((i) => [i.getAttribute('value'), i.hasAttribute('selected')])).to.deep.equal([
      ['a', true],
      ['b', false],
    ]);
    // The model is the model picker's: the agent button names only the agent.
    expect(root.querySelector('.acp-agent-picker__button')?.textContent).to.not.contain('Opus');
    expect(tooltipOf(root.querySelector('#acp-agent-picker-button'))).to.equal('Agent: A');
    const icon = /** @type {import('../../agent-icon/agent-icon.js').AcpAgentIcon | null} */ (
      root.querySelector('acp-agent-icon.acp-agent-picker__glyph[slot="icon"]')
    );
    expect(icon?.agent, 'its agent as a logo icon').to.equal(a);
  });

  it('picks an agent', async () => {
    const a = { id: 'a', name: 'A', configOptions: [] };
    const b = { id: 'b', name: 'B', configOptions: [] };
    const composer = { ...NO_AGENT, agentId: 'a' };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[a, b]} .agent=${a}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[value="b"]'));
    /** @type {unknown[]} */
    const picked = [];
    el.addEventListener('acp-agent-select', (/** @type {Event} */ e) => picked.push(/** @type {CustomEvent} */ (e).detail));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: 'b', item } }));
    expect(picked).to.deep.equal([{ agentId: 'b' }]);
  });

  it("fixes a started session's agent: no other agent to switch to", async () => {
    const a = { id: 'a', name: 'A', configOptions: [] };
    const b = { id: 'b', name: 'B', configOptions: [] };
    const composer = { ...NO_AGENT, agentId: 'a', started: true };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[a, b]} .agent=${a}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('md-menu-item[value="b"]')).to.equal(null);
    expect(root.querySelector('[data-action]')).to.equal(null);
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[disabled]'));
    expect(item.querySelector('[slot="supporting-text"]')?.textContent?.trim()).to.equal('Fixed for this session');
    expect(root.querySelector('.acp-agent-picker__lock')).to.not.equal(null);
    expect(tooltipOf(root.querySelector('#acp-agent-picker-button'))).to.equal('Agent: A · fixed for this session');
  });

  it('says when a started session\'s agent is gone from agents.json', async () => {
    const agent = { id: 'claude', name: 'Claude Code', removed: true };
    const composer = { ...NO_AGENT, agentId: 'claude', started: true };
    const el = await fixture(html`<acp-agent-picker .composer=${composer} .agents=${[]} .agent=${agent}></acp-agent-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-agent-picker__agent')?.textContent?.trim()).to.equal('Claude Code (removed)');
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[disabled]'));
    expect(item.querySelector('[slot="supporting-text"]')?.textContent?.trim()).to.equal('No longer in agents.json');
  });
});
