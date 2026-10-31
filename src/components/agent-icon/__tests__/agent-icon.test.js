import { expect, fixture, html } from '../../../../test/fixture.js';
import claudeIcon from '../../../assets/agent-icons/claude.svg?raw';
import copilotIcon from '../../../assets/agent-icons/copilot.svg?raw';
import genericIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import '../agent-icon.js';

/** The markup as the browser serializes it, so it compares with what an element renders. */
const asHtml = (/** @type {string} */ svg) => {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.innerHTML;
};

/** @param {Element} el */
const shown = (el) => el.querySelector('md-icon')?.innerHTML.replace(/<!--.*?-->/g, '') ?? '';

describe('acp-agent-icon', () => {
  it('renders into itself, an inline-flex box in its parent’s tree with no shadow root', async () => {
    const el = await fixture(html`<acp-agent-icon .agent=${{ id: 'claude-code', name: 'Claude Code' }}></acp-agent-icon>`);
    expect(el.shadowRoot === null, 'no shadow root').to.equal(true);
    expect(el.querySelector('md-icon') !== null, 'an icon inside').to.equal(true);
    expect(el.style.display).to.equal('inline-flex');
  });

  it('shows the logo of a supported agent and names its brand', async () => {
    const el = await fixture(html`<acp-agent-icon .agent=${{ id: 'claude-code', name: 'Claude Code' }}></acp-agent-icon>`);
    expect(el.getAttribute('brand')).to.equal('claude');
    expect(shown(el)).to.equal(asHtml(claudeIcon));
  });

  it('knows the brand from the id or the name, whichever carries it', async () => {
    const byId = await fixture(html`<acp-agent-icon .agent=${{ id: 'github-copilot-cli', name: 'Copilot' }}></acp-agent-icon>`);
    expect(byId.getAttribute('brand')).to.equal('copilot');
    const byName = await fixture(html`<acp-agent-icon .agent=${{ id: 'mine', name: 'My Claude' }}></acp-agent-icon>`);
    expect(byName.getAttribute('brand')).to.equal('claude');
  });

  it('shows a generic icon, and no brand, for an agent of no known brand', async () => {
    const el = await fixture(html`<acp-agent-icon .agent=${{ id: 'mine', name: null }}></acp-agent-icon>`);
    expect(el.hasAttribute('brand')).to.equal(false);
    expect(shown(el)).to.equal(asHtml(genericIcon));
  });

  it('follows the agent', async () => {
    const el = await fixture(html`<acp-agent-icon .agent=${{ id: 'claude-acp' }}></acp-agent-icon>`);
    el.agent = { id: 'github-copilot-cli' };
    await el.updateComplete;
    expect(el.getAttribute('brand')).to.equal('copilot');
    expect(shown(el)).to.equal(asHtml(copilotIcon));
    el.agent = { id: 'other' };
    await el.updateComplete;
    expect(el.hasAttribute('brand')).to.equal(false);
  });
});
