import { expect, fixture, html } from '../../../../test/fixture.js';
import '../agent-form.js';

/** @typedef {import('../../../hooks/agents/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../agent-form.js').AcpAgentForm} AcpAgentForm */
/** @typedef {import('../agent-form.js').EditedAgent} EditedAgent */

/** @type {KnownAgent[]} */
const KNOWN = [
  { id: 'claude-acp', name: 'Claude Agent', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli@0.65.0', '--acp'] },
];

/** @type {EditedAgent} */
const CLAUDE = { id: 'mine', name: 'My Claude', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] };

/** @param {EditedAgent} agent */
async function render(agent) {
  const el = /** @type {AcpAgentForm} */ (await fixture(html`<acp-agent-form .known=${KNOWN} .agent=${agent}></acp-agent-form>`));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * @param {ShadowRoot} root
 * @param {string} label
 */
function field(root, label) {
  return /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector(`md-text-field[label="${label}"]`));
}

/**
 * Types into an md-text-field the way a user does.
 * @param {ShadowRoot} root
 * @param {string} label
 * @param {string} value
 */
function type(root, label, value) {
  field(root, label).value = value;
  field(root, label).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

/**
 * @param {ShadowRoot} root
 * @param {string} text
 */
function button(root, text) {
  const found = [...root.querySelectorAll('md-button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no ${text} button`);
  return /** @type {HTMLElementTagNameMap['md-button']} */ (found);
}

/** @param {ShadowRoot} root */
function custom(root) {
  return /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-agent-form__custom'));
}

/**
 * @param {ShadowRoot} root
 * @param {string} value
 */
function pickAgent(root, value) {
  const select = /** @type {HTMLElementTagNameMap['md-select']} */ (root.querySelector('md-select[label="Agent"]'));
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Collects an event's details.
 * @param {HTMLElement} el
 * @param {string} type
 */
function heard(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

describe('acp-agent-form', () => {
  it('edits a registry agent in place, its launch still the registry’s', async () => {
    const { el, root } = await render(CLAUDE);
    expect(root.querySelector('.acp-agent-form__subtitle')?.textContent).to.equal('Edit My Claude');
    const options = [...root.querySelectorAll('md-option')].map((o) => o.textContent?.trim());
    expect(options, 'only the registry’s agents').to.deep.equal(['Claude Agent', 'Gemini CLI']);
    expect(field(root, 'Command').disabled, 'the registry launch').to.equal(true);
    pickAgent(root, 'gemini');
    await el.updateComplete;
    expect(field(root, 'Name').value, 'an edit keeps its name').to.equal('My Claude');
    const updated = heard(el, 'acp-agent-update');
    button(root, 'Save').click();
    expect(updated).to.deep.equal([{ agentId: 'mine', agent: { name: 'My Claude', known: 'gemini' } }]);
  });

  it('changes the command line, split as a shell would', async () => {
    const { el, root } = await render(CLAUDE);
    custom(root).click();
    await el.updateComplete;
    type(root, 'Command', `npx -y @agentclientprotocol/claude-agent-acp@0.94.0 --model 'opus 4'`);
    await el.updateComplete;
    const updated = heard(el, 'acp-agent-update');
    button(root, 'Save').click();
    expect(updated).to.deep.equal([
      {
        agentId: 'mine',
        agent: { name: 'My Claude', known: 'claude-acp', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0', '--model', 'opus 4'] },
      },
    ]);
  });

  it('cancels without asking for anything', async () => {
    const { el, root } = await render(CLAUDE);
    type(root, 'Name', 'X');
    const updated = heard(el, 'acp-agent-update');
    const closed = heard(el, 'acp-agent-form-close');
    button(root, 'Cancel').click();
    root.querySelector('.acp-agent-form__form')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).to.have.length(2);
    expect(updated).to.have.length(0);
  });

  it('edits any other command line, and removes from the form', async () => {
    const { el, root } = await render({ id: 'repo', name: 'Repo', command: './run', args: ['--acp'] });
    expect(field(root, 'Command').value).to.equal('./run --acp');
    expect(field(root, 'Command').disabled).to.equal(false);
    const removed = heard(el, 'acp-agent-remove');
    button(root, 'Remove').click();
    expect(removed).to.deep.equal([{ agentId: 'repo' }]);
  });
});
