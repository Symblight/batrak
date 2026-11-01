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
  it('shows the installed agents as cards, your agents and the registry as rows, with the problems and counts', async () => {
    const { root } = await render();
    expect([...root.querySelectorAll('.acp-agents-view__problem')].map(text)).to.deep.equal(['agents.json:3:4: expected value']);
    expect([...root.querySelectorAll('.acp-agents-view__group-title')].map(text)).to.deep.equal([
      'Installed · 3',
      'Your agents',
      'From the ACP registry',
    ]);
    expect([...root.querySelectorAll('md-filter-chip')].map(text)).to.deep.equal(['All', 'Updates 2', 'Off 1']);
    const cards = /** @type {HTMLElementTagNameMap['acp-agent-card'][]} */ ([...root.querySelectorAll('acp-agent-card')]);
    expect(cards.map((c) => c.agent?.id)).to.deep.equal(['claude', 'gem', 'codex']);
    const copilot = row(root, 'github-copilot-cli');
    expect(text(/** @type {Element} */ (copilot.querySelector('.acp-agents-view__details')))).to.equal('GitHub · npx -y @github/copilot@1.0.101 --acp');
    expect(tooltipOf(root, button(copilot, 'Add'))).to.equal("Add Copilot, pinned to the registry's version");
    expect(text(/** @type {Element} */ (row(root, 'mine').querySelector('.acp-agents-view__details')))).to.equal('mine');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agents-view__footer')))).to.contain('Versions are checked against the ACP registry daily');
  });

  it('shows when the registry was last checked', async () => {
    const { root } = await render();
    const state = /** @type {Element} */ (root.querySelector('.acp-agents-view__footer-state'));
    expect(text(state)).to.contain('Last checked');
    const when = /** @type {HTMLElementTagNameMap['acp-datetime']} */ (state.querySelector('acp-datetime'));
    expect(when.value).to.equal('2026-10-21T08:00:00.000Z');
    expect(when.textContent?.trim()).to.not.equal('');
  });

  it('shows each of your agents and the registry’s as a logo icon and a name with the search matches marked', async () => {
    const view = { ...VIEW, registry: [{ ...VIEW.registry[0], nameMatches: /** @type {[number, number][]} */ ([[0, 2]]) }] };
    const { root } = await render({ view, query: { query: 'co', filter: 'all' } });
    /** @param {string} id */
    const icon = (id) =>
      /** @type {import('../../agent-icon/agent-icon.js').AcpAgentIcon | null} */ (row(root, id).querySelector('.acp-agents-view__glyph acp-agent-icon'));
    for (const id of ['github-copilot-cli', 'mine']) expect(icon(id)?.agent?.id, id).to.equal(id);
    const marked = /** @type {HTMLElementTagNameMap['acp-marked-text']} */ (row(root, 'github-copilot-cli').querySelector('acp-marked-text'));
    expect([marked.text, marked.ranges]).to.deep.equal(['Copilot', [[0, 2]]]);
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

  it('hands each card its state: the terminal choice, an update running here, a sign-in, a reveal', async () => {
    /** @type {SignInRun} */
    const run = { state: 'waiting', message: null, terminal: null };
    const { el, root } = await render({ terminalAgents: ['claude'], pending: { updating: ['gem'], checking: false }, signIns: { codex: run } });
    el.reveal = { agentId: 'codex' };
    await el.updateComplete;
    /** @param {string} id */
    const card = (id) => /** @type {HTMLElementTagNameMap['acp-agent-card']} */ (row(root, id).querySelector('acp-agent-card'));
    expect(['claude', 'gem', 'codex'].map((id) => card(id).terminalView)).to.deep.equal([true, false, false]);
    expect(['claude', 'gem', 'codex'].map((id) => card(id).updating)).to.deep.equal([false, true, false]);
    expect(card('codex').signIn).to.equal(run);
    expect(['claude', 'gem', 'codex'].map((id) => card(id).revealed)).to.deep.equal([false, false, true]);
  });

  it('updates all, checks the registry and shows that it does', async () => {
    const { el, root } = await render({ pending: { updating: [], checking: true } });
    const all = heard(el, 'acp-agents-update-all');
    const checked = heard(el, 'acp-agents-registry-check');
    button(root, 'Update all').click();
    expect(all).to.have.length(1);
    expect(button(root, 'Checking…').disabled).to.equal(true);
    el.pending = { updating: [], checking: false };
    await el.updateComplete;
    button(root, 'Check now').click();
    expect(checked).to.have.length(1);
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

  it("replaces a card with the edit form when the card asks to edit, and back when it closes", async () => {
    const { el, root } = await render();
    row(root, 'codex').querySelector('acp-agent-card')?.dispatchEvent(new CustomEvent('acp-agent-edit', { detail: { agentId: 'codex' }, bubbles: true, composed: true }));
    await el.updateComplete;
    const form = /** @type {HTMLElementTagNameMap['acp-agent-form']} */ (root.querySelector('acp-agent-form'));
    expect(form.agent?.id, 'the form in place of its card').to.equal('codex');
    expect(row(root, 'codex').querySelector('acp-agent-card')).to.equal(null);
    form.dispatchEvent(new CustomEvent('acp-agent-form-close', { detail: null }));
    await el.updateComplete;
    expect(root.querySelector('acp-agent-form')).to.equal(null);
    expect(row(root, 'codex').querySelector('acp-agent-card')).not.to.equal(null);
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
    expect(/** @type {HTMLElementTagNameMap['acp-agent-card']} */ (row(root, 'codex').querySelector('acp-agent-card')).revealed).to.equal(true);
    expect(revealed).to.deep.equal([{ reveal: add }, { reveal: show }]);
  });

  it('asks to open agents.json', async () => {
    const { el, root } = await render();
    const opened = heard(el, 'acp-agents-file-open');
    button(root, 'Edit agents.json').click();
    expect(opened).to.have.length(1);
  });
});
