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
  it('renders into itself, showing the logo and brand of a supported agent, a generic icon otherwise, following the agent', async () => {
    const el = await fixture(html`<acp-agent-icon .agent=${{ id: 'claude-code', name: 'Claude Code' }}></acp-agent-icon>`);
    expect(el.shadowRoot === null, 'no shadow root').to.equal(true);
    expect(el.getAttribute('brand')).to.equal('claude');
    expect(shown(el)).to.equal(asHtml(claudeIcon));

    el.agent = { id: 'github-copilot-cli' };
    await el.updateComplete;
    expect(el.getAttribute('brand')).to.equal('copilot');
    expect(shown(el)).to.equal(asHtml(copilotIcon));

    el.agent = { id: 'mine', name: null };
    await el.updateComplete;
    expect(el.hasAttribute('brand'), 'no brand').to.equal(false);
    expect(shown(el)).to.equal(asHtml(genericIcon));
  });
});
