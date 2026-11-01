import { expect, fixture, html } from '../../../../test/fixture.js';
import '../agent-card.js';

/** @typedef {import('../../../models/types/types.js').AgentRow} AgentRow */
/** @typedef {import('../../../models/types/types.js').SignInMethod} SignInMethod */
/** @typedef {import('../../../models/types/types.js').SignInRun} SignInRun */
/** @typedef {import('../agent-card.js').AcpAgentCard} AcpAgentCard */

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

const CLAUDE = agent({
  id: 'claude',
  name: 'Claude Code',
  isDefault: true,
  version: '0.90.0',
  status: 'ready',
  update: { to: '0.94.0', pin: false },
  terminal: { resume: true, new: true },
  description: "ACP wrapper for Anthropic's Claude",
});

/**
 * @param {Partial<SignInMethod> & { id: string, name: string }} method
 * @returns {SignInMethod}
 */
const method = (method) => ({ description: null, kind: 'agent', label: null, apiKey: null, ...method });

/**
 * @param {Partial<AcpAgentCard> & { agent: AgentRow }} props
 */
async function render(props) {
  const el = /** @type {AcpAgentCard} */ (await fixture(html`<acp-agent-card></acp-agent-card>`));
  Object.assign(el, props);
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {Element} el */
const text = (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/**
 * @param {ParentNode} root
 * @param {string} label
 */
function button(root, label) {
  const found = [...root.querySelectorAll('md-button')].find((b) => text(b) === label);
  if (!found) throw new Error(`no ${label} button`);
  return /** @type {HTMLElementTagNameMap['md-button']} */ (found);
}

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

/** Opens the menu behind `button` and waits for its render. @param {AcpAgentCard} el @param {string} selector */
async function openMenu(el, selector) {
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector(selector));
  await menu.updateComplete;
  return menu;
}

describe('acp-agent-card', () => {
  it('shows an agent with its logo, Default mark, version, description and the tooltips of its controls', async () => {
    const { root } = await render({ agent: CLAUDE });
    expect(/** @type {HTMLElementTagNameMap['acp-marked-text']} */ (root.querySelector('.acp-agent-card__title acp-marked-text')).text).to.equal('Claude Code');
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agent-card__title')))).to.equal('Default');
    expect(/** @type {HTMLElementTagNameMap['acp-agent-icon']} */ (root.querySelector('.acp-agent-card__glyph acp-agent-icon')).agent.id).to.equal('claude');
    expect(text(/** @type {Element} */ (root.querySelector('.acp-agent-card__details'))), 'its description').to.equal("ACP wrapper for Anthropic's Claude");
    expect(tooltipOf(root, /** @type {Element} */ (root.querySelector('md-switch')))).to.equal('Turn off: no new sessions, and its sessions stop');
    expect(tooltipOf(root, button(root, 'Update'))).to.equal('Pin 0.94.0 in agents.json');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);

    const unknown = await render({ agent: agent({ id: 'gem', name: 'Gemini CLI', update: { to: '0.65.0', pin: true } }) });
    expect(button(unknown.root, 'Pin latest (0.65.0)'), 'version unknown: pin it').to.be.ok;

    const off = await render({ agent: agent({ id: 'codex', name: 'Codex', enabled: false, status: 'off' }) });
    expect(text(/** @type {Element} */ (off.root.querySelector('.acp-agent-card__details')))).to.equal('Project · Off');
    expect(tooltipOf(off.root, /** @type {Element} */ (off.root.querySelector('md-switch')))).to.equal('Turn on');
  });

  it('marks what the search matched in the name', async () => {
    const { root } = await render({ agent: { ...CLAUDE, nameMatches: [[0, 2], [7, 9]] } });
    const marked = /** @type {HTMLElementTagNameMap['acp-marked-text']} */ (root.querySelector('acp-marked-text'));
    expect(marked.text).to.equal('Claude Code');
    expect(marked.ranges).to.deep.equal([[0, 2], [7, 9]]);
  });

  it('lets an agent with a CLI choose Chat or Terminal for its sessions', async () => {
    const { el, root } = await render({ agent: CLAUDE, terminalView: true });
    const views = heard(el, 'acp-agent-session-view');
    const radios = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...root.querySelectorAll('md-radio')]);
    expect(radios.map((r) => [r.value, r.checked, r.disabled])).to.deep.equal([
      ['chat', false, false],
      ['terminal', true, false],
    ]);
    const group = /** @type {HTMLFieldSetElement} */ (root.querySelector('fieldset'));
    expect(text(/** @type {Element} */ (group.querySelector('legend')))).to.equal('Open sessions in');
    expect(radios.every((r) => group.contains(r)), 'one group per agent').to.equal(true);
    const [chatText, terminalText] = [...group.querySelectorAll('.acp-agent-card__mode-text')].map(text);
    expect(chatText, 'its version on the Chat line, its description under it').to.equal("Chat 0.90.0 → 0.94.0 ACP wrapper for Anthropic's Claude");
    expect(terminalText).to.equal('Terminal CLI available');
    expect(root.querySelectorAll('md-switch'), 'one switch for the agent').to.have.length(1);
    expect(root.querySelector('.acp-agent-card__more'), 'the chat option keeps the menu').not.to.equal(null);

    radios[0].checked = true;
    radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(views).to.deep.equal([{ agentId: 'claude', view: 'chat' }]);

    el.terminalView = false;
    await el.updateComplete;
    expect(radios.map((r) => r.checked)).to.deep.equal([true, false]);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(views.at(-1)).to.deep.equal({ agentId: 'claude', view: 'terminal' });

    const gem = await render({ agent: agent({ id: 'gem', name: 'Gemini CLI' }), terminalView: true });
    const gemRadios = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...gem.root.querySelectorAll('md-radio')]);
    expect(gemRadios.map((r) => [r.value, r.checked, r.disabled]), 'no CLI: Terminal disabled, Chat shown').to.deep.equal([
      ['chat', true, false],
      ['terminal', false, true],
    ]);
    expect(text(/** @type {Element} */ (gem.root.querySelector('fieldset')))).to.contain('No CLI for this agent');
  });

  it('shows an agent that is off without the Chat / Terminal choice, keeping its switch and menu', async () => {
    const { root } = await render({ agent: agent({ id: 'codex', name: 'Codex', enabled: false, status: 'off', terminal: { resume: true, new: true } }), terminalView: true });
    expect(root.querySelector('fieldset'), 'no choice').to.equal(null);
    expect(root.querySelector('md-switch'), 'its switch stays').not.to.equal(null);
    expect(root.querySelector('.acp-agent-card__more'), 'its menu stays').not.to.equal(null);
  });

  it('moves between Chat and Terminal with the arrow keys', async () => {
    const { el, root } = await render({ agent: agent({ id: 'copilot', name: 'Copilot', terminal: { resume: true, new: true } }) });
    const views = heard(el, 'acp-agent-session-view');
    const radios = /** @type {HTMLElementTagNameMap['md-radio'][]} */ ([...root.querySelectorAll('md-radio')]);
    await Promise.all(radios.map((r) => r.updateComplete));
    radios[0].focusInteractive();
    radios[0].input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
    expect(radios[1].checked).to.equal(true);
    expect(views).to.deep.equal([{ agentId: 'copilot', view: 'terminal' }]);
  });

  it('turns the agent on and off and updates it', async () => {
    const { el, root } = await render({ agent: CLAUDE });
    const enabled = heard(el, 'acp-agent-enable');
    const updated = heard(el, 'acp-agent-version-update');
    const sw = /** @type {HTMLElementTagNameMap['md-switch']} */ (root.querySelector('md-switch'));
    sw.selected = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    button(root, 'Update').click();
    expect(enabled).to.deep.equal([{ agentId: 'claude', enabled: false }]);
    expect(updated).to.deep.equal([{ agentId: 'claude' }]);
  });

  it('shows Updating… while an update runs, here or in another window', async () => {
    for (const props of [{ agent: CLAUDE, updating: true }, { agent: { ...CLAUDE, updating: true } }]) {
      const { root } = await render(props);
      const updating = button(root, 'Updating…');
      expect(updating.disabled).to.equal(true);
      expect(updating.querySelector('md-progress-circular')).to.be.ok;
      expect(() => button(root, 'Update'), 'no second Update').to.throw();
    }
  });

  it("edits, makes default and removes from the agent's menu", async () => {
    const { el, root } = await render({ agent: agent({ id: 'codex', name: 'Codex', enabled: false, status: 'off' }) });
    const heardEvents = Object.fromEntries(['edit', 'default', 'remove'].map((what) => [what, heard(el, `acp-agent-${what}`)]));
    /** @type {HTMLElement} */ (root.querySelector('.acp-agent-card__more')).click();
    const menu = await openMenu(el, '.acp-agent-card__menu');
    const item = (/** @type {string} */ value) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
    expect(item('default').disabled, 'an agent that is off').to.equal(true);
    for (const value of ['remove', 'edit']) menu.dispatchEvent(new CustomEvent('select', { detail: { value, item: item(value) } }));
    expect(heardEvents.remove).to.deep.equal([{ agentId: 'codex' }]);
    expect(heardEvents.edit).to.deep.equal([{ agentId: 'codex' }]);
    expect(heardEvents.default).to.deep.equal([]);
  });

  it('opens its menu on a right click', async () => {
    const { el, root } = await render({ agent: CLAUDE });
    const event = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 20, clientY: 20 });
    root.querySelector('.acp-agent-card__header')?.dispatchEvent(event);
    expect(event.defaultPrevented).to.equal(true);
    const menu = await openMenu(el, '.acp-agent-card__menu');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.open).to.equal(true);
    menu.close();
  });

  it('offers to sign in: one way runs it, more open a menu of them, none checks again', async () => {
    const browser = method({ id: 'browser', name: 'Log in with your browser' });
    const zed = agent({ id: 'zed', name: 'Zed', status: 'signIn', signIn: { methods: [browser], pending: false } });
    const copilot = agent({
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
    });
    const gemini = agent({ id: 'gemini', name: 'Gemini CLI', status: 'signIn', signIn: { methods: [method({ id: 'key', name: 'Key', apiKey: { provider: 'gemini' } })], pending: false } });

    const one = await render({ agent: zed });
    const asked = heard(one.el, 'acp-agent-sign-in');
    expect(text(/** @type {Element} */ (one.root.querySelector('.acp-agent-card__details')))).to.contain('Needs sign-in');
    button(one.root, 'Sign in').click();
    expect(asked).to.deep.equal([{ agentId: 'zed', methodId: 'browser' }]);

    const many = await render({ agent: copilot });
    const askedMany = heard(many.el, 'acp-agent-sign-in');
    button(many.root, 'Sign in').click();
    const menu = await openMenu(many.el, '.acp-agent-card__sign-in-menu');
    const items = [...menu.querySelectorAll('md-menu-item')];
    expect(items.map(text), 'no API keys').to.deep.equal(['Copilot Login', 'Device code']);
    const device = /** @type {HTMLElementTagNameMap['md-menu-item']} */ (items[1]);
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: device.value, item: device } }));
    expect(askedMany).to.deep.equal([{ agentId: 'copilot', methodId: 'device' }]);

    const none = await render({ agent: gemini });
    const askedNone = heard(none.el, 'acp-agent-sign-in');
    const retry = button(none.root, 'Retry');
    expect(tooltipOf(none.root, retry)).to.equal("Check whether you're signed in now");
    retry.click();
    expect(askedNone).to.deep.equal([{ agentId: 'gemini', methodId: null }]);
  });

  it('shows Signing in… while a sign-in runs, here or in another window, and why one failed', async () => {
    const signIn = { methods: [method({ id: 'browser', name: 'Log in' })], pending: false };
    const zed = agent({ id: 'zed', name: 'Zed', status: 'signIn', signIn: { ...signIn, pending: true } });
    const copilot = agent({ id: 'copilot', name: 'GitHub Copilot', status: 'signIn', signIn });
    /** @type {SignInRun} */
    const waiting = { state: 'waiting', message: null, terminal: null };
    /** @type {SignInRun} */
    const failed = { state: 'failed', message: 'Copilot Login exited with 1', terminal: null };

    for (const props of [{ agent: zed }, { agent: copilot, signIn: waiting }]) {
      const { root } = await render(props);
      const signingIn = button(root, 'Signing in…');
      expect(signingIn.disabled).to.equal(true);
      expect(signingIn.querySelector('md-progress-circular')).to.be.ok;
    }
    const { root } = await render({ agent: copilot, signIn: failed });
    const failure = /** @type {Element} */ (root.querySelector('.acp-agent-card__error'));
    expect(text(failure)).to.equal('Signing in failed: Copilot Login exited with 1');
    expect(tooltipOf(root, failure), 'one line: the whole of it in a tooltip').to.equal('Signing in failed: Copilot Login exited with 1');
    expect(button(root, 'Sign in').disabled).to.equal(false);
  });
});
