import { expect, fixture, html } from '../../../../test/fixture.js';
import '../agents-view.js';

/** @typedef {import('../../../models/types/types.js').AgentsView} AgentsView */
/** @typedef {import('../../../models/types/types.js').AgentRow} AgentRow */
/** @typedef {import('../../../models/types/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../../models/types/types.js').SignInMethod} SignInMethod */
/** @typedef {import('../../../models/types/types.js').SignInRun} SignInRun */
/** @typedef {import('../agents-view.js').AcpAgentsView} AcpAgentsView */

/**
 * @param {Partial<AgentRow> & { id: string, name: string }} row
 * @returns {AgentRow}
 */
const agent = (row) => /** @type {AgentRow} */ ({
  scope: 'project',
  enabled: true,
  isDefault: false,
  command: row.id,
  args: [],
  version: null,
  update: null,
  updating: false,
  status: 'notStarted',
  signIn: null,
  nameMatches: [],
  terminal: null,
  description: null,
  ...row,
});

/** @type {AgentsView} */
const VIEW = {
  installed: [
    agent({ id: 'claude', name: 'Claude Code', isDefault: true, version: '0.90.0', status: 'ready', update: { to: '0.94.0', pin: false }, terminal: { resume: true, new: true }, description: 'ACP wrapper for Anthropic\'s Claude' }),
    agent({ id: 'gem', name: 'Gemini CLI', update: { to: '0.65.0', pin: true } }),
    agent({ id: 'codex', name: 'Codex', enabled: false, status: 'off' }),
  ],
  userAgents: [agent({ id: 'mine', name: 'Mine', scope: 'user' })],
  registry: [
    { id: 'github-copilot-cli', name: 'Copilot', vendor: 'GitHub', description: '', commandLine: 'npx -y @github/copilot@1.0.101 --acp', nameMatches: [] },
  ],
  counts: { all: 3, updates: 2, off: 1 },
  defaultAgent: 'claude',
  errors: ['agents.json:3:4: expected value'],
  registryState: { checkedAt: '2026-10-21T08:00:00.000Z', offline: false, checking: false },
};

/** @type {AgentsQuery} */
const ALL = { query: '', filter: 'all' };

/**
 * @param {Partial<SignInMethod> & { id: string, name: string }} method
 * @returns {SignInMethod}
 */
const method = (method) => ({ description: null, kind: 'agent', label: null, apiKey: null, ...method });

/**
 * @param {{ view?: AgentsView, query?: AgentsQuery, pending?: { updating: string[], checking: boolean }, signIns?: Record<string, SignInRun>, terminalAgents?: string[] }} [props]
 */
async function render({ view = VIEW, query = ALL, pending = { updating: [], checking: false }, signIns = {}, terminalAgents = [] } = {}) {
  const el = /** @type {AcpAgentsView} */ (
    await fixture(
      html`<acp-agents-view .view=${view} .query=${query} .pending=${pending} .signIns=${signIns} .terminalAgents=${terminalAgents} .known=${[]}></acp-agents-view>`,
    )
  );
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * @param {ParentNode} root
 * @param {string} text
 */
function button(root, text) {
  const found = [...root.querySelectorAll('md-button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no ${text} button`);
  return /** @type {HTMLElementTagNameMap['md-button']} */ (found);
}

/**
 * @param {ShadowRoot} root
 * @param {string} id
 */
function row(root, id) {
  const found = root.querySelector(`[data-agent-id="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

/**
 * @param {Element} el
 */
const text = (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/**
 * The text of the `md-tooltip` anchored to `el`.
 * @param {ShadowRoot} root
 * @param {Element} el
 */
const tooltipOf = (root, el) => {
  const tooltip = el.id ? root.querySelector(`md-tooltip[for="${CSS.escape(el.id)}"]`) : null;
  return tooltip ? text(tooltip) : null;
};

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

describe('acp-agents-view', () => {
  it('shows the installed agents, your agents and the registry, with the problems and counts', async () => {
    const { root } = await render();
    expect([...root.querySelectorAll('.acp-agents-view__problem')].map(text)).to.deep.equal(['agents.json:3:4: expected value']);
    expect([...root.querySelectorAll('.acp-agents-view__group-title')].map(text)).to.deep.equal([
      'Installed · 3',
      'Your agents',
      'From the ACP registry',
    ]);
    expect([...root.querySelectorAll('md-filter-chip')].map(text)).to.deep.equal(['All', 'Updates 2', 'Off 1']);
    const claude = row(root, 'claude');
    expect(text(/** @type {Element} */ (claude.querySelector('.acp-agents-view__title')))).to.equal('Claude Code Default');
    expect(text(/** @type {Element} */ (claude.querySelector('.acp-agents-view__details'))), 'a card: its description').to.equal(
      "ACP wrapper for Anthropic's Claude",
    );
    expect(text(/** @type {Element} */ (row(root, 'codex').querySelector('.acp-agents-view__details')))).to.equal('Project · Off');
    expect(button(row(root, 'gem'), 'Pin latest (0.65.0)'), 'version unknown: pin it').to.be.ok;
    const copilot = row(root, 'github-copilot-cli');
    expect(text(/** @type {Element} */ (copilot.querySelector('.acp-agents-view__details')))).to.equal('GitHub · npx -y @github/copilot@1.0.101 --acp');
    expect(tooltipOf(root, button(copilot, 'Add'))).to.equal("Add Copilot, pinned to the registry's version");
    expect(tooltipOf(root, /** @type {Element} */ (claude.querySelector('md-switch')))).to.equal('Turn off: no new sessions, and its sessions stop');
    expect(tooltipOf(root, /** @type {Element} */ (row(root, 'codex').querySelector('md-switch')))).to.equal('Turn on');
    expect(tooltipOf(root, button(claude, 'Update'))).to.equal('Pin 0.94.0 in agents.json');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agents-view__footer')))).to.contain('Versions are checked against the ACP registry daily');
  });

  it('shows each agent as a logo icon, a generic one for an agent of no known brand', async () => {
    const { root } = await render();
    /** @param {string} id */
    const icon = (id) => row(root, id).querySelector('.acp-agents-view__glyph acp-agent-icon');
    expect(icon('claude')?.getAttribute('brand')).to.equal('claude');
    expect(icon('claude')?.shadowRoot?.querySelector('svg')).to.not.equal(null);
    expect(icon('github-copilot-cli')?.getAttribute('brand')).to.equal('copilot');
    expect(icon('mine')?.hasAttribute('brand')).to.equal(false);
  });

  it('marks what the search matched in a name', async () => {
    const view = { ...VIEW, installed: [agent({ id: 'claude', name: 'Claude Code', nameMatches: [[0, 2], [7, 9]] })] };
    const { root } = await render({ view, query: { query: 'cl co', filter: 'all' } });
    expect([...row(root, 'claude').querySelectorAll('mark')].map(text)).to.deep.equal(['Cl', 'Co']);
    expect(root.querySelector('.acp-agents-view__update-all'), 'Update all only without a query').to.equal(null);
  });

  it('asks for a search and a filter, and clears the search', async () => {
    const { el, root } = await render({ query: { query: 'cla', filter: 'all' } });
    const asked = heard(el, 'acp-agents-query');
    const input = /** @type {HTMLInputElement} */ (root.querySelector('.acp-agents-view__search-input'));
    expect(input.value).to.equal('cla');
    input.value = 'clau';
    input.dispatchEvent(new Event('input'));
    /** @type {HTMLElement} */ ([...root.querySelectorAll('md-filter-chip')][2]).click();
    /** @type {HTMLElement} */ (root.querySelector('.acp-agents-view__clear')).click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(asked).to.deep.equal([
      { query: 'clau', filter: 'all' },
      { query: 'cla', filter: 'off' },
      { query: '', filter: 'all' },
      { query: '', filter: 'all' },
    ]);
  });

  it('focuses the search on ⌘F / Ctrl+F', async () => {
    const { root } = await render();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(root.activeElement).to.equal(root.querySelector('.acp-agents-view__search-input'));
  });

  it('lets an agent with a CLI choose Chat or Terminal for its sessions', async () => {
    const { el, root } = await render({ terminalAgents: ['claude'] });
    const views = heard(el, 'acp-agent-session-view');
    const claude = row(root, 'claude');
    const radios = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...claude.querySelectorAll('md-radio')]);
    expect(radios.map((r) => r.value)).to.deep.equal(['chat', 'terminal']);
    expect(radios.map((r) => r.checked)).to.deep.equal([false, true]);
    const group = /** @type {HTMLFieldSetElement} */ (claude.querySelector('fieldset'));
    expect(text(/** @type {Element} */ (group.querySelector('legend')))).to.equal('Open sessions in');
    expect(radios.every((r) => group.contains(r)), 'one group per agent').to.equal(true);
    const [chatText, terminalText] = [...group.querySelectorAll('.acp-agents-view__mode-text')].map((e) => text(e));
    expect(chatText, 'its version on the Chat line, its description under it').to.equal("Chat 0.90.0 → 0.94.0 ACP wrapper for Anthropic's Claude");
    expect(terminalText).to.equal('Terminal CLI available');
    expect(text(group))
      .to.contain('Chat')
      .and.contain('Terminal')
      .and.contain('CLI available');
    expect(claude.querySelectorAll('md-switch'), 'one switch for the agent').to.have.length(1);
    expect(claude.querySelector('.acp-agents-view__more'), 'the chat option keeps the menu').not.to.equal(null);

    radios[0].checked = true;
    radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(views).to.deep.equal([{ agentId: 'claude', view: 'chat' }]);

    el.terminalAgents = [];
    await el.updateComplete;
    expect(radios.map((r) => r.checked)).to.deep.equal([true, false]);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(views.at(-1)).to.deep.equal({ agentId: 'claude', view: 'terminal' });

    const gem = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...row(root, 'gem').querySelectorAll('md-radio')]);
    expect(gem.map((r) => [r.value, r.checked, r.disabled]), 'no CLI: Terminal disabled').to.deep.equal([
      ['chat', true, false],
      ['terminal', false, true],
    ]);
    expect(text(/** @type {Element} */ (row(root, 'gem').querySelector('fieldset')))).to.contain('No CLI for this agent');
  });

  it('shows every installed agent as a card: its name and switch, then where its sessions open', async () => {
    const { root } = await render();
    for (const id of ['claude', 'gem']) {
      const card = row(root, id);
      expect(card.classList.contains('acp-agents-view__card'), id).to.equal(true);
      expect(card.querySelector('.acp-agents-view__card-header md-switch'), `${id}: its switch on top`).not.to.equal(null);
      expect(card.querySelector('.acp-agents-view__mode .acp-agents-view__more'), `${id}: its menu on the Chat option`).not.to.equal(null);
      expect([...card.querySelectorAll('.acp-agents-view__mode-name')].map(text).map((t) => t.split(' ')[0])).to.deep.equal(['Chat', 'Terminal']);
    }
  });

  it('hides the Chat / Terminal choice of an agent that is off', async () => {
    const { root } = await render({ terminalAgents: ['codex'] });
    const codex = row(root, 'codex');
    expect(codex.classList.contains('acp-agents-view__card')).to.equal(true);
    expect(codex.querySelector('fieldset'), 'no choice').to.equal(null);
    expect(codex.querySelector('md-switch'), 'its switch stays').not.to.equal(null);
    expect(codex.querySelector('.acp-agents-view__more'), 'its menu stays').not.to.equal(null);
  });
  it('moves between Chat and Terminal with the arrow keys, within one agent', async () => {
    const view = { ...VIEW, installed: [...VIEW.installed, agent({ id: 'copilot', name: 'Copilot', terminal: { resume: true, new: true } })] };
    const { el, root } = await render({ view });
    const views = heard(el, 'acp-agent-session-view');
    const radios = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...row(root, 'claude').querySelectorAll('md-radio')]);
    await Promise.all(radios.map((r) => r.updateComplete));
    radios[0].focusInteractive();
    radios[0].input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
    expect(radios[1].checked).to.equal(true);
    expect(views).to.deep.equal([{ agentId: 'claude', view: 'terminal' }]);
    const copilot = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...row(root, 'copilot').querySelectorAll('md-radio')]);
    expect(copilot.map((r) => r.checked), "another agent's choice stays").to.deep.equal([true, false]);
  });

  it('turns agents on and off, updates them, and checks the registry', async () => {
    const { el, root } = await render();
    const enabled = heard(el, 'acp-agent-enable');
    const updated = heard(el, 'acp-agent-version-update');
    const all = heard(el, 'acp-agents-update-all');
    const checked = heard(el, 'acp-agents-registry-check');
    const codex = /** @type {HTMLElementTagNameMap['md-switch']} */ (row(root, 'codex').querySelector('md-switch'));
    codex.selected = true;
    codex.dispatchEvent(new Event('change', { bubbles: true }));
    button(row(root, 'claude'), 'Update').click();
    button(root, 'Update all').click();
    button(root, 'Check now').click();
    expect(enabled).to.deep.equal([{ agentId: 'codex', enabled: true }]);
    expect(updated).to.deep.equal([{ agentId: 'claude' }]);
    expect(all).to.have.length(1);
    expect(checked).to.have.length(1);
  });

  it('shows Updating… while an update runs, here or in another window', async () => {
    const view = { ...VIEW, installed: [VIEW.installed[0], { ...VIEW.installed[1], updating: true }] };
    const { root } = await render({ view, pending: { updating: ['claude'], checking: true } });
    for (const id of ['claude', 'gem']) {
      const updating = button(row(root, id), 'Updating…');
      expect(updating.disabled, id).to.equal(true);
      expect(updating.querySelector('md-progress-circular'), id).to.be.ok;
    }
    expect(button(root, 'Checking…').disabled).to.equal(true);
  });

  it('adds a registry agent in one click, and the user’s own agents to the project', async () => {
    const { el, root } = await render();
    const added = heard(el, 'acp-agent-add');
    const imported = heard(el, 'acp-agents-import');
    button(row(root, 'github-copilot-cli'), 'Add').click();
    await el.updateComplete;
    expect(added).to.deep.equal([{ agent: { name: '', known: 'github-copilot-cli' } }]);
    expect(button(row(root, 'github-copilot-cli'), 'Adding…').disabled).to.equal(true);
    el.saveFinished('npx not found');
    await el.updateComplete;
    const error = /** @type {Element} */ (row(root, 'github-copilot-cli').querySelector('.acp-agents-view__error'));
    expect(text(error)).to.equal('npx not found');
    expect(tooltipOf(root, error)).to.equal('npx not found');

    button(row(root, 'mine'), 'Add to project').click();
    button(root, 'Add all').click();
    expect(imported).to.deep.equal([{ agentIds: ['mine'] }, { agentIds: ['mine'] }]);
  });

  it("edits, makes default and removes from a row's menu", async () => {
    const { el, root } = await render();
    const asked = [...['acp-agent-default', 'acp-agent-remove'].map((type) => heard(el, type))];
    /** @type {HTMLElement} */ (row(root, 'codex').querySelector('.acp-agents-view__more')).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-agents-view__menu'));
    await menu.updateComplete;
    const item = (/** @type {string} */ value) =>
      /** @type {HTMLElementTagNameMap['md-menu-item']} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
    expect(item('default').disabled, 'an agent that is off').to.equal(true);
    const pick = (/** @type {string} */ value) => menu.dispatchEvent(new CustomEvent('select', { detail: { value, item: item(value) } }));
    pick('remove');
    expect(asked[1]).to.deep.equal([{ agentId: 'codex' }]);
    pick('edit');
    await el.updateComplete;
    const form = /** @type {HTMLElementTagNameMap['acp-agent-form']} */ (root.querySelector('acp-agent-form'));
    expect(form.agent?.id, 'the form in place of its row').to.equal('codex');
    expect(root.querySelector('[data-agent-id="codex"] .acp-agents-view__name')).to.equal(null);
    form.dispatchEvent(new CustomEvent('acp-agent-form-close', { detail: null }));
    await el.updateComplete;
    expect(root.querySelector('acp-agent-form')).to.equal(null);
  });

  it('adds only from the registry: no custom agent, and says when nothing matched', async () => {
    const { root } = await render();
    expect(() => button(root, 'Add agent'), 'no add form').to.throw();
    const empty = { ...VIEW, installed: [], userAgents: [], registry: [] };
    const { root: none } = await render({ view: empty, query: { query: 'Hermes', filter: 'all' } });
    expect(text(/** @type {Element} */ (none.querySelector('.acp-agents-view__empty')))).to.equal('No agents match “Hermes”.');
    expect(none.querySelector('md-button.acp-agents-view__empty-add'), 'no custom agent').to.equal(null);
  });

  it('says when the registry has not answered yet', async () => {
    const never = { ...VIEW, installed: [], userAgents: [], registry: [], registryState: { checkedAt: null, offline: false, checking: true } };
    const { root } = await render({ view: never });
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agents-view__empty')))).to.equal('Getting the agents from the ACP registry…');
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agents-view__footer-state')))).to.contain('Not checked yet');
    const offline = { ...never, registryState: { checkedAt: null, offline: true, checking: false } };
    const { root: away } = await render({ view: offline });
    expect(text(/** @type {Element} */ (away.querySelector('.acp-agents-view__empty')))).to.equal(
      'Couldn’t reach the ACP registry, which lists the agents. Brama tries again every minute.',
    );
  });

  it('shows the registry or an agent when asked, and says when it has', async () => {
    const { el, root } = await render();
    const revealed = heard(el, 'acp-agents-revealed');
    const add = { add: true };
    el.reveal = add;
    await el.updateComplete;
    expect(root.querySelector('acp-agent-form'), 'no add form').to.equal(null);
    const show = { agentId: 'codex' };
    el.reveal = show;
    await el.updateComplete;
    expect(row(root, 'codex').classList.contains('acp-agents-view__row_revealed')).to.equal(true);
    expect(revealed).to.deep.equal([{ reveal: add }, { reveal: show }]);
  });

  it('offers to sign in: one way runs it, more open a menu of them, none checks again', async () => {
    const browser = method({ id: 'browser', name: 'Log in with your browser' });
    const view = {
      ...VIEW,
      installed: [
        agent({ id: 'zed', name: 'Zed', status: 'signIn', signIn: { methods: [browser], pending: false } }),
        agent({
          id: 'copilot',
          name: 'GitHub Copilot',
          status: 'signIn',
          signIn: {
            methods: [
              method({ id: 'copilot-login', name: 'Copilot Login', kind: 'terminal' }),
              method({ id: 'key', name: 'API key', apiKey: { provider: 'github' } }),
              method({ id: 'device', name: 'Device code' }),
            ],
            pending: false,
          },
        }),
        agent({ id: 'gemini', name: 'Gemini CLI', status: 'signIn', signIn: { methods: [method({ id: 'key', name: 'Key', apiKey: { provider: 'gemini' } })], pending: false } }),
      ],
    };
    const { el, root } = await render({ view });
    const asked = heard(el, 'acp-agent-sign-in');
    expect(text(/** @type {Element} */ (row(root, 'zed').querySelector('.acp-agents-view__details')))).to.contain('Needs sign-in');

    button(row(root, 'zed'), 'Sign in').click();
    expect(asked).to.deep.equal([{ agentId: 'zed', methodId: 'browser' }]);

    button(row(root, 'copilot'), 'Sign in').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-agents-view__sign-in-menu'));
    await menu.updateComplete;
    const items = [...menu.querySelectorAll('md-menu-item')];
    expect(items.map((i) => text(i))).to.deep.equal(['Copilot Login', 'Device code'], 'no API keys');
    const device = /** @type {HTMLElementTagNameMap['md-menu-item']} */ (items[1]);
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: device.value, item: device } }));
    expect(asked[1]).to.deep.equal({ agentId: 'copilot', methodId: 'device' });

    const retry = button(row(root, 'gemini'), 'Retry');
    expect(tooltipOf(root, retry)).to.equal("Check whether you're signed in now");
    retry.click();
    expect(asked[2]).to.deep.equal({ agentId: 'gemini', methodId: null });
  });

  it('shows Signing in… while a sign-in runs, here or in another window, and why one failed', async () => {
    const signIn = { methods: [method({ id: 'browser', name: 'Log in' })], pending: false };
    const view = {
      ...VIEW,
      installed: [
        agent({ id: 'zed', name: 'Zed', status: 'signIn', signIn: { ...signIn, pending: true } }),
        agent({ id: 'copilot', name: 'GitHub Copilot', status: 'signIn', signIn }),
        agent({ id: 'codex', name: 'Codex', status: 'signIn', signIn }),
      ],
    };
    /** @type {Record<string, SignInRun>} */
    const signIns = {
      copilot: { state: 'waiting', message: null, terminal: null },
      codex: { state: 'failed', message: 'Copilot Login exited with 1', terminal: null },
    };
    const { root } = await render({ view, signIns });
    for (const id of ['zed', 'copilot']) {
      const signingIn = button(row(root, id), 'Signing in…');
      expect(signingIn.disabled, id).to.equal(true);
      expect(signingIn.querySelector('md-progress-circular'), id).to.be.ok;
    }
    const codex = row(root, 'codex');
    const failure = /** @type {Element} */ (codex.querySelector('.acp-agents-view__error'));
    expect(text(failure)).to.equal('Signing in failed: Copilot Login exited with 1');
    expect(tooltipOf(root, failure), 'one line: the whole of it in a tooltip').to.equal('Signing in failed: Copilot Login exited with 1');
    expect(button(codex, 'Sign in').disabled).to.equal(false);
  });

  it('asks to open agents.json', async () => {
    const { el, root } = await render();
    const opened = heard(el, 'acp-agents-file-open');
    button(root, 'Edit agents.json').click();
    expect(opened).to.have.length(1);
  });
});
