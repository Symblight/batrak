import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-settings-agents.js';

/** @typedef {import('../../../models/types.js').AgentList} AgentList */
/** @typedef {import('../acp-settings-agents.js').AcpSettingsAgents} AcpSettingsAgents */

/** @type {AgentList} */
const LIST = {
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      scope: 'user',
      version: '0.9.2',
      registryId: null,
      update: null,
      enabled: true,
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    },
    { id: 'repo', name: 'Repo agent', scope: 'project', version: null, registryId: null, update: null, enabled: true, command: './run', args: ['--acp'] },
    { id: 'local', name: 'Local', scope: 'user', version: null, registryId: null, update: null, enabled: true, command: 'local', args: [] },
  ],
  defaultAgent: 'claude-code',
  known: [
    { id: 'claude-code', name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    { id: 'gemini', name: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
  ],
  userAgents: [],
  errors: [],
};

/** @param {AgentList} agents */
async function render(agents = LIST) {
  const el = /** @type {AcpSettingsAgents} */ (await fixture(html`<acp-settings-agents .agents=${agents}></acp-settings-agents>`));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * Types into an md-text-field the way a user does.
 * @param {ShadowRoot} root
 * @param {string} label
 * @param {string} value
 */
function type(root, label, value) {
  const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector(`md-text-field[label="${label}"]`));
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

/**
 * @param {ShadowRoot} root
 * @param {string} label
 */
function field(root, label) {
  return /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector(`md-text-field[label="${label}"]`));
}

/** @param {ShadowRoot} root */
function custom(root) {
  return /** @type {HTMLElementTagNameMap['md-checkbox']} */ (root.querySelector('.acp-settings-agents__custom'));
}

/**
 * Opens the menu of the `index`th row from its button.
 * @param {AcpSettingsAgents} el
 * @param {ShadowRoot} root
 * @param {number} index
 */
async function openMenu(el, root, index) {
  const row = root.querySelectorAll('.acp-settings-agents__row')[index];
  /** @type {HTMLElement} */ (row.querySelector('.acp-settings-agents__more')).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-settings-agents__menu'));
  await menu.updateComplete;
  return menu;
}

/**
 * @param {HTMLElementTagNameMap['md-menu']} menu
 * @param {string} value
 */
function item(menu, value) {
  return /** @type {HTMLElementTagNameMap['md-menu-item']} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
}

/**
 * @param {HTMLElementTagNameMap['md-menu']} menu
 * @param {string} value
 */
function pick(menu, value) {
  menu.dispatchEvent(new CustomEvent('select', { detail: { value, item: item(menu, value) } }));
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

describe('acp-settings-agents', () => {
  it('lists every agent with its type, version and status', async () => {
    const { root } = await render();
    const rows = [...root.querySelectorAll('.acp-settings-agents__row')];
    expect(rows.map((r) => r.querySelector('.acp-settings-agents__name')?.textContent?.trim())).to.deep.equal([
      'Claude Code',
      'Repo agent',
      'Local',
    ]);
    const details = rows.map((r) => r.querySelector('.acp-settings-agents__details')?.textContent?.replace(/\s+/g, ' ').trim());
    expect(details).to.deep.equal(['ACP · 0.9.2 · Ready', 'ACP · Not started yet', 'ACP · Not started yet']);
  });

  it('turns an agent on and off with its switch', async () => {
    const agents = LIST.agents.map((a) => (a.id === 'repo' ? { ...a, enabled: false } : a));
    const { el, root } = await render({ ...LIST, agents });
    const switches = /** @type {HTMLElementTagNameMap['md-switch'][]} */ ([...root.querySelectorAll('md-switch')]);
    expect(switches.map((s) => s.selected)).to.deep.equal([true, false, true]);
    const repo = root.querySelectorAll('.acp-settings-agents__row')[1];
    expect(repo.querySelector('.acp-settings-agents__details')?.textContent?.replace(/\s+/g, ' ').trim()).to.equal('ACP · Off');

    /** @type {unknown[]} */
    const fired = [];
    el.addEventListener('acp-agent-enable', (e) => fired.push(/** @type {CustomEvent} */ (e).detail));
    switches[0].selected = false;
    switches[0].dispatchEvent(new Event('change', { bubbles: true }));
    switches[1].selected = true;
    switches[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(fired).to.deep.equal([
      { agentId: 'claude-code', enabled: false },
      { agentId: 'repo', enabled: true },
    ]);
  });

  it('adds a known agent with its own command, which the backend fills in', async () => {
    const { el, root } = await render();
    expect(root.querySelector('.acp-settings-agents__form')).to.equal(null);
    button(root, 'Add agent').click();
    await el.updateComplete;
    const select = /** @type {HTMLElementTagNameMap['md-select']} */ (root.querySelector('md-select[label="Agent"]'));
    const options = [...root.querySelectorAll('md-option')].map((o) => o.textContent?.trim());
    expect(options).to.deep.equal(['Claude Code', 'Gemini CLI', 'Other agent']);
    select.value = 'gemini';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Name').value).to.equal('Gemini CLI');
    expect(field(root, 'Command').value).to.equal('npx -y @google/gemini-cli --acp');
    expect(field(root, 'Command').disabled, 'locked to the registry').to.equal(true);

    /** @type {unknown[]} */
    const added = [];
    el.addEventListener('acp-agent-add', (e) => added.push(/** @type {CustomEvent} */ (e).detail.agent));
    button(root, 'Save').click();
    await el.updateComplete;
    expect(added).to.deep.equal([{ name: 'Gemini CLI', known: 'gemini' }]);
    expect(button(root, 'Save').disabled, 'while saving').to.equal(true);

    el.saveFinished('agents.json:3:1: expected value; fix agents.json first');
    await el.updateComplete;
    expect(root.querySelector('.acp-settings-agents__error')?.textContent).to.contain('fix agents.json first');
    expect(button(root, 'Save').disabled, 'can try again').to.equal(false);

    el.saveFinished(null);
    await el.updateComplete;
    expect(root.querySelector('.acp-settings-agents__form'), 'closed once added').to.equal(null);
  });

  it('adds a custom command line, split as a shell would', async () => {
    const { el, root } = await render();
    el.startAdding();
    await el.updateComplete;
    expect(field(root, 'Name').value, 'the first agent not added yet').to.equal('Gemini CLI');
    custom(root).checked = true;
    custom(root).dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Command').disabled).to.equal(false);
    expect(field(root, 'Command').value, 'starts from the registry').to.equal('npx -y @google/gemini-cli --acp');
    type(root, 'Command', '  ');
    await el.updateComplete;
    expect(button(root, 'Save').disabled, 'no program').to.equal(true);
    type(root, 'Command', 'gemini --acp --name "a b"');
    /** @type {unknown[]} */
    const added = [];
    el.addEventListener('acp-agent-add', (e) => added.push(/** @type {CustomEvent} */ (e).detail.agent));
    await el.updateComplete;
    button(root, 'Save').click();
    expect(added).to.deep.equal([{ name: 'Gemini CLI', known: 'gemini', command: 'gemini', args: ['--acp', '--name', 'a b'] }]);

    el.saveFinished('no');
    custom(root).checked = false;
    custom(root).dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Command').value, 'unchecking restores the registry command').to.equal('npx -y @google/gemini-cli --acp');
  });

  it('takes any program as another agent', async () => {
    const { el, root } = await render();
    el.startAdding();
    await el.updateComplete;
    const select = /** @type {HTMLElementTagNameMap['md-select']} */ (root.querySelector('md-select[label="Agent"]'));
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(field(root, 'Name').value).to.equal('');
    expect(field(root, 'Command').disabled).to.equal(false);
    expect(custom(root).disabled, 'nothing to lock to').to.equal(true);
    type(root, 'Name', 'Local');
    type(root, 'Command', './agent --acp');
    await el.updateComplete;
    /** @type {unknown[]} */
    const added = [];
    el.addEventListener('acp-agent-add', (e) => added.push(/** @type {CustomEvent} */ (e).detail.agent));
    button(root, 'Save').click();
    expect(added).to.deep.equal([{ name: 'Local', command: './agent', args: ['--acp'] }]);
  });

  it('cancels adding without asking for anything', async () => {
    const { el, root } = await render();
    el.startAdding();
    await el.updateComplete;
    type(root, 'Name', 'X');
    let asked = false;
    el.addEventListener('acp-agent-add', () => (asked = true));
    button(root, 'Cancel').click();
    await el.updateComplete;
    expect(root.querySelector('.acp-settings-agents__form')).to.equal(null);
    expect(asked).to.equal(false);
    el.startAdding();
    await el.updateComplete;
    const name = /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('md-text-field[label="Name"]'));
    expect(name.value, 'starts over').to.equal('Gemini CLI');
  });

  it('marks the default agent', async () => {
    const { root } = await render();
    const marked = [...root.querySelectorAll('.acp-settings-agents__row')].map(
      (r) => r.querySelector('.acp-settings-agents__default')?.textContent?.trim() ?? null,
    );
    expect(marked).to.deep.equal(['Default', null, null]);
  });

  it("asks from a row's menu to make an agent the default or remove it", async () => {
    const { el, root } = await render();
    /** @type {unknown[]} */
    const asked = [];
    for (const type of ['acp-agent-default', 'acp-agent-remove']) {
      el.addEventListener(type, (e) => asked.push([type, /** @type {CustomEvent} */ (e).detail]));
    }
    const menu = await openMenu(el, root, 1);
    expect(menu.open).to.equal(true);
    expect(item(menu, 'default').disabled).to.equal(false);
    pick(menu, 'default');
    pick(menu, 'remove');
    expect(asked).to.deep.equal([
      ['acp-agent-default', { agentId: 'repo' }],
      ['acp-agent-remove', { agentId: 'repo' }],
    ]);
    await menu.close();
    const again = await openMenu(el, root, 0);
    expect(item(again, 'default').disabled, 'already the default').to.equal(true);
  });

  it('edits a known agent in place, its launch still the registry’s', async () => {
    const { el, root } = await render();
    pick(await openMenu(el, root, 0), 'edit');
    await el.updateComplete;
    const rows = [...root.querySelectorAll('.acp-settings-agents__list > li')];
    expect(rows[0].querySelector('.acp-settings-agents__form'), 'in place of its row').to.not.equal(null);
    expect(root.querySelector('.acp-settings-agents__subtitle')?.textContent?.trim()).to.equal('Edit Claude Code');
    const select = /** @type {HTMLElementTagNameMap['md-select']} */ (root.querySelector('md-select[label="Agent"]'));
    expect(select.value).to.equal('claude-code');
    expect(field(root, 'Command').disabled).to.equal(true);
    type(root, 'Name', 'Claude');
    await el.updateComplete;
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-agent-update', (e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    button(root, 'Save').click();
    expect(asked).to.deep.equal([{ agentId: 'claude-code', agent: { name: 'Claude', known: 'claude-code' } }]);
    el.saveFinished(null);
    await el.updateComplete;
    expect(root.querySelector('.acp-settings-agents__form')).to.equal(null);
  });

  it('edits any other command line, and removes from the form', async () => {
    const { el, root } = await render();
    pick(await openMenu(el, root, 1), 'edit');
    await el.updateComplete;
    const select = /** @type {HTMLElementTagNameMap['md-select']} */ (root.querySelector('md-select[label="Agent"]'));
    expect(select.value).to.equal('');
    expect(field(root, 'Command').value).to.equal('./run --acp');
    expect(field(root, 'Command').disabled).to.equal(false);
    /** @type {unknown[]} */
    const removed = [];
    el.addEventListener('acp-agent-remove', (e) => removed.push(/** @type {CustomEvent} */ (e).detail));
    button(root, 'Remove').click();
    expect(removed).to.deep.equal([{ agentId: 'repo' }]);
  });

  it('follows agents.json: a row removed in the file goes, its open edit form too', async () => {
    const { el, root } = await render();
    pick(await openMenu(el, root, 1), 'edit');
    await el.updateComplete;
    el.agents = { ...LIST, agents: LIST.agents.filter((a) => a.id !== 'repo') };
    await el.updateComplete;
    const names = [...root.querySelectorAll('.acp-settings-agents__name')].map((n) => n.textContent?.trim());
    expect(names).to.deep.equal(['Claude Code', 'Local']);
    expect(root.querySelector('.acp-settings-agents__form')).to.equal(null);
    el.agents = LIST;
    await el.updateComplete;
    expect(root.querySelector('.acp-settings-agents__form'), 'not reopened when it comes back').to.equal(null);
  });

  it('offers to add the agents of the user\'s own agents.json to the project', async () => {
    const mine = { id: 'mine', name: 'Mine', scope: /** @type {const} */ ('user'), version: null, registryId: null, update: null, enabled: true, command: 'mine', args: [] };
    const { el, root } = await render({ ...LIST, userAgents: [mine] });
    const box = /** @type {HTMLElement} */ (root.querySelector('.acp-settings-agents__elsewhere'));
    expect(box.textContent?.replace(/\s+/g, ' ')).to.contain('Mine is in your own agents.json');
    let asked = 0;
    el.addEventListener('acp-agents-import', () => asked++);
    button(root, 'Add to this project').click();
    expect(asked).to.equal(1);

    const none = await render(LIST);
    expect(none.root.querySelector('.acp-settings-agents__elsewhere')).to.equal(null);
  });

  it("shows the files' problems and says when there is no agent", async () => {
    const { root } = await render({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: ['agents.json:4:2: expected value'] });
    expect(root.querySelector('.acp-settings-agents__problem')?.textContent).to.contain('agents.json:4:2');
    expect(root.querySelector('.acp-settings-agents__empty')).to.not.equal(null);
  });
});
