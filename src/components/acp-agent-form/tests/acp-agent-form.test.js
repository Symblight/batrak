import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-agent-form.js';

/** @typedef {import('../../../models/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../acp-agent-form.js').AcpAgentForm} AcpAgentForm */
/** @typedef {import('../acp-agent-form.js').EditedAgent} EditedAgent */

/** @type {KnownAgent[]} */
const KNOWN = [
  { id: 'claude-acp', name: 'Claude Agent', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli@0.65.0', '--acp'] },
];

/**
 * @param {{ agent?: EditedAgent | null, preset?: { known: string, name: string } }} [props]
 */
async function render({ agent = null, preset = { known: '', name: '' } } = {}) {
  const el = /** @type {AcpAgentForm} */ (
    await fixture(html`<acp-agent-form .known=${KNOWN} .agent=${agent} .preset=${preset}></acp-agent-form>`)
  );
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
  it('adds a registry agent with its pinned launch, which the backend fills in', async () => {
    const { el, root } = await render();
    const options = [...root.querySelectorAll('md-option')].map((o) => o.textContent?.trim());
    expect(options).to.deep.equal(['Claude Agent', 'Gemini CLI', 'Other agent']);
    pickAgent(root, 'gemini');
    await el.updateComplete;
    expect(field(root, 'Name').value).to.equal('Gemini CLI');
    expect(field(root, 'Command').value).to.equal('npx -y @google/gemini-cli@0.65.0 --acp');
    expect(field(root, 'Command').disabled, 'locked to the registry').to.equal(true);

    const added = heard(el, 'acp-agent-add');
    const closed = heard(el, 'acp-agent-form-close');
    button(root, 'Save').click();
    await el.updateComplete;
    expect(added).to.deep.equal([{ agent: { name: 'Gemini CLI', known: 'gemini' } }]);
    expect(button(root, 'Save').disabled, 'while saving').to.equal(true);

    el.saveFinished('agents.json:3:1: expected value; fix agents.json first');
    await el.updateComplete;
    expect(root.querySelector('.acp-agent-form__error')?.textContent).to.contain('fix agents.json first');
    expect(button(root, 'Save').disabled, 'can try again').to.equal(false);
    expect(closed).to.have.length(0);

    el.saveFinished(null);
    expect(closed, 'done once added').to.have.length(1);
  });

  it('adds a custom command line, split as a shell would', async () => {
    const { el, root } = await render({ preset: { known: 'gemini', name: '' } });
    expect(field(root, 'Name').value, 'from the preset').to.equal('Gemini CLI');
    custom(root).checked = true;
    custom(root).dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Command').disabled).to.equal(false);
    expect(field(root, 'Command').value, 'starts from the registry').to.equal('npx -y @google/gemini-cli@0.65.0 --acp');
    type(root, 'Command', '  ');
    await el.updateComplete;
    expect(button(root, 'Save').disabled, 'no program').to.equal(true);
    type(root, 'Command', 'gemini --acp --name "a b"');
    await el.updateComplete;
    const added = heard(el, 'acp-agent-add');
    button(root, 'Save').click();
    expect(added).to.deep.equal([{ agent: { name: 'Gemini CLI', known: 'gemini', command: 'gemini', args: ['--acp', '--name', 'a b'] } }]);

    el.saveFinished('no');
    custom(root).checked = false;
    custom(root).dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Command').value, 'unchecking restores the registry command').to.equal('npx -y @google/gemini-cli@0.65.0 --acp');
  });

  it('takes any program as another agent, its name from the preset', async () => {
    const { el, root } = await render({ preset: { known: '', name: 'Local' } });
    expect(field(root, 'Name').value).to.equal('Local');
    expect(field(root, 'Command').disabled).to.equal(false);
    expect(custom(root).disabled, 'nothing to lock to').to.equal(true);
    type(root, 'Command', './agent --acp');
    await el.updateComplete;
    const added = heard(el, 'acp-agent-add');
    button(root, 'Save').click();
    expect(added).to.deep.equal([{ agent: { name: 'Local', command: './agent', args: ['--acp'] } }]);
  });

  it('cancels without asking for anything', async () => {
    const { el, root } = await render();
    type(root, 'Name', 'X');
    const added = heard(el, 'acp-agent-add');
    const closed = heard(el, 'acp-agent-form-close');
    button(root, 'Cancel').click();
    root.querySelector('.acp-agent-form__form')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).to.have.length(2);
    expect(added).to.have.length(0);
  });

  it('edits a registry agent in place, its launch still the registry’s', async () => {
    const agent = { id: 'mine', name: 'My Claude', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] };
    const { el, root } = await render({ agent });
    expect(root.querySelector('.acp-agent-form__subtitle')?.textContent).to.equal('Edit My Claude');
    expect(field(root, 'Command').disabled, 'the registry launch').to.equal(true);
    pickAgent(root, 'gemini');
    await el.updateComplete;
    expect(field(root, 'Name').value, 'an edit keeps its name').to.equal('My Claude');
    const updated = heard(el, 'acp-agent-update');
    button(root, 'Save').click();
    expect(updated).to.deep.equal([{ agentId: 'mine', agent: { name: 'My Claude', known: 'gemini' } }]);
  });

  it('edits any other command line, and removes from the form', async () => {
    const { el, root } = await render({ agent: { id: 'repo', name: 'Repo', command: './run', args: ['--acp'] } });
    expect(field(root, 'Command').value).to.equal('./run --acp');
    expect(field(root, 'Command').disabled).to.equal(false);
    const removed = heard(el, 'acp-agent-remove');
    button(root, 'Remove').click();
    expect(removed).to.deep.equal([{ agentId: 'repo' }]);
  });
});
