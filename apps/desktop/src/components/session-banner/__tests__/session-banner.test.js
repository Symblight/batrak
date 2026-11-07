import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../session-banner.js';

describe('acp-session-banner', () => {
  it('offers Restart when agents.json changed what the running agent runs', async () => {
    const notice = { kind: /** @type {const} */ ('outdated'), message: 'agents.json changed what Fake runs. Restart to use it.' };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const banner = /** @type {HTMLElement & { label: string, dismissible: boolean }} */ (root.querySelector('chx-input-mode-banner'));
    expect(banner.label).to.equal(notice.message);
    expect(banner.dismissible).to.equal(true);
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Restart']);
    /** @type {unknown[]} */
    const acted = [];
    el.addEventListener('acp-session-action', (/** @type {Event} */ e) => acted.push(/** @type {CustomEvent} */ (e).detail.action));
    /** @type {HTMLElement} */ (buttons[0]).click();
    expect(acted).to.deep.equal(['restart']);
  });

  it('offers Turn on instead of Restart when the user turned the agent off', async () => {
    const notice = { kind: /** @type {const} */ ('error'), message: 'Codex is off', offAgent: 'codex' };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Open log', 'Turn on']);
    /** @type {unknown[]} */
    const acted = [];
    el.addEventListener('acp-session-action', (/** @type {Event} */ e) => acted.push(/** @type {CustomEvent} */ (e).detail.action));
    /** @type {HTMLElement} */ (buttons[1]).click();
    expect(acted).to.deep.equal(['turn-on-agent']);
  });

  it('links a queued turn to the session it waits for', async () => {
    const notice = { kind: /** @type {const} */ ('queued'), message: 'Waiting for "Fix the tree" to finish', holder: { id: 'a', title: 'Fix the tree' } };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const banner = /** @type {HTMLElement & { label: string, dismissible: boolean }} */ (root.querySelector('chx-input-mode-banner'));
    expect(banner.label).to.equal(notice.message);
    expect(banner.dismissible).to.equal(false);
    /** @type {unknown[]} */
    const selected = [];
    el.addEventListener('acp-session-select', (/** @type {Event} */ e) => selected.push(/** @type {CustomEvent} */ (e).detail));
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Show session']);
    /** @type {HTMLElement} */ (buttons[0]).click();
    expect(selected).to.deep.equal([{ sessionId: 'a' }]);
  });

  it('offers to create AGENTS.md only when nothing else needs the banner', async () => {
    const offer = 'This project has no AGENTS.md, the instructions file coding agents share.';
    const notice = { kind: /** @type {const} */ ('info'), message: 'Noted' };
    const permission = { requestId: 'r', toolCallId: 't', title: 'Edit a file?', options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }] };
    const cases = [
      { props: { agentsMdOffer: true }, hidden: false, label: offer, buttons: ['Create AGENTS.md'] },
      { props: { agentsMdOffer: true, notice }, hidden: false, label: 'Noted', buttons: [] },
      { props: { agentsMdOffer: true, permission }, hidden: false, label: 'Edit a file?', buttons: ['Allow'] },
      { props: { agentsMdOffer: false }, hidden: true, label: '', buttons: [] },
    ];
    for (const { props, hidden, label, buttons } of cases) {
      // Arrange
      const el = await fixture(html`<acp-session-banner></acp-session-banner>`);

      // Act
      Object.assign(el, props);
      await /** @type {import('lit').LitElement} */ (el).updateComplete;

      // Assert
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const banner = /** @type {HTMLElement & { label: string }} */ (root.querySelector('chx-input-mode-banner'));
      expect({ hidden: banner.hidden, label: banner.label }, JSON.stringify(props)).to.deep.equal({ hidden, label });
      expect([...root.querySelectorAll('md-button')].map((b) => b.textContent?.trim())).to.deep.equal(buttons);
    }
  });

  it('Create AGENTS.md asks for it', async () => {
    // Arrange
    const el = await fixture(html`<acp-session-banner .agentsMdOffer=${true}></acp-session-banner>`);
    /** @type {CustomEvent[]} */
    const fired = [];
    el.addEventListener('acp-agents-md-create', (/** @type {Event} */ e) => fired.push(/** @type {CustomEvent} */ (e)));

    // Act
    /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('md-button')).click();

    // Assert
    expect(fired.map((e) => [e.bubbles, e.composed]), 'one event that leaves the banner').to.deep.equal([[true, true]]);
  });

  it('its dismiss button dismisses what the banner shows: the offer, else a notice that can go', async () => {
    const info = { kind: /** @type {const} */ ('info'), message: 'Noted' };
    const queued = { kind: /** @type {const} */ ('queued'), message: 'Waiting', holder: { id: 'a', title: 'A' } };
    const permission = { requestId: 'r', toolCallId: 't', title: 'Edit a file?', options: [] };
    const cases = [
      { props: { agentsMdOffer: true }, fired: ['acp-agents-md-dismiss'] },
      { props: { agentsMdOffer: true, notice: info }, fired: ['acp-session-action'] },
      { props: { agentsMdOffer: true, notice: queued }, fired: null },
      { props: { agentsMdOffer: true, permission }, fired: null },
    ];
    for (const { props, fired } of cases) {
      // Arrange
      const el = await fixture(html`<acp-session-banner></acp-session-banner>`);
      Object.assign(el, props);
      await /** @type {import('lit').LitElement} */ (el).updateComplete;
      const banner = /** @type {import('lit').LitElement} */ (el.shadowRoot?.querySelector('chx-input-mode-banner'));
      await banner.updateComplete;
      /** @type {string[]} */
      const heard = [];
      for (const type of ['acp-agents-md-dismiss', 'acp-session-action']) el.addEventListener(type, (/** @type {Event} */ e) => heard.push(e.type));

      // Act
      const button = /** @type {HTMLElement | null} */ (banner.renderRoot.querySelector('[part="dismiss"]'));
      button?.click();

      // Assert
      expect(button === null ? null : heard, Object.keys(props).join()).to.deep.equal(fired);
    }
  });

  describe('sign-in', () => {
    /** @param {Partial<import('../../../hooks/agents/types.js').SignInMethod> & { id: string, name: string }} method */
    const method = (method) => ({ description: null, kind: /** @type {const} */ ('agent'), label: null, apiKey: null, ...method });
    /** @param {import('../../../hooks/agents/types.js').SignInMethod[]} methods */
    const notice = (methods) => ({
      kind: /** @type {const} */ ('sign-in'),
      message: 'Sign in to Codex to continue.',
      signIn: { agentId: 'codex', agentName: 'Codex', methods },
    });

    /** @param {Element} el */
    const view = (el) => {
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const banner = /** @type {HTMLElement & { label: string, variant: string }} */ (root.querySelector('chx-input-mode-banner'));
      const buttons = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('md-button')]);
      return { banner, buttons, names: buttons.map((b) => b.textContent?.trim()) };
    };

    /** @param {Element} el */
    const events = (el) => {
      /** @type {[string, unknown][]} */
      const seen = [];
      for (const type of ['acp-agent-sign-in', 'acp-agent-sign-in-cancel', 'acp-session-action']) {
        el.addEventListener(type, (/** @type {Event} */ e) => seen.push([type, /** @type {CustomEvent} */ (e).detail]));
      }
      return seen;
    };

    it("offers the agent's own sign-ins and Retry", async () => {
      const methods = [method({ id: 'chat-gpt', name: 'ChatGPT' }), method({ id: 'api-key', name: 'API Key', apiKey: { provider: 'openai' } })];
      const el = await fixture(html`<acp-session-banner .notice=${notice(methods)} .permission=${null}></acp-session-banner>`);
      const { banner, buttons, names } = view(el);
      expect(banner.label).to.equal('Sign in to Codex to continue.');
      expect(names, 'an API key needs settings first').to.deep.equal(['ChatGPT', 'Retry']);
      const seen = events(el);
      buttons[0].click();
      buttons[1].click();
      expect(seen).to.deep.equal([
        ['acp-agent-sign-in', { agentId: 'codex', methodId: 'chat-gpt' }],
        ['acp-agent-sign-in', { agentId: 'codex', methodId: null }],
      ]);
    });

    it("explains a sign-in and Retry in tooltips, not titles", async () => {
      const methods = [method({ id: 'chat-gpt', name: 'ChatGPT', description: 'Use your ChatGPT plan' })];
      const el = await fixture(html`<acp-session-banner .notice=${notice(methods)} .permission=${null}></acp-session-banner>`);
      const { buttons } = view(el);
      expect(buttons.map(tooltipOf)).to.deep.equal(['Use your ChatGPT plan', "Check whether you're signed in now"]);
      expect(el.shadowRoot.querySelector('[title]')).to.equal(null);
    });

    it('offers terminal logins as sign-ins too', async () => {
      const methods = [
        method({ id: 'claude-ai-login', name: 'Claude subscription', kind: 'terminal' }),
        method({ id: 'copilot-login', name: 'Log in with Copilot CLI', kind: 'command', label: 'Copilot Login' }),
      ];
      const el = await fixture(html`<acp-session-banner .notice=${notice(methods)} .permission=${null}></acp-session-banner>`);
      const { buttons, names } = view(el);
      expect(names).to.deep.equal(['Claude subscription', 'Log in with Copilot CLI', 'Retry']);
      const seen = events(el);
      buttons[1].click();
      expect(seen).to.deep.equal([['acp-agent-sign-in', { agentId: 'codex', methodId: 'copilot-login' }]]);
    });

    it('with no way to sign in, sends the user to a terminal, then Retry', async () => {
      const el = await fixture(html`<acp-session-banner .notice=${notice([])} .permission=${null}></acp-session-banner>`);
      const { banner, buttons, names } = view(el);
      expect(banner.label).to.equal('Codex needs you to sign in. Run its login in a terminal, then Retry.');
      expect(names).to.deep.equal(['Open terminal', 'Retry']);
      const seen = events(el);
      buttons[0].click();
      expect(seen).to.deep.equal([['acp-session-action', { action: 'open-terminal' }]]);
    });

    it("points at a login's terminal while it runs", async () => {
      const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
      const run = { state: /** @type {const} */ ('waiting'), message: null, terminal };
      const el = await fixture(
        html`<acp-session-banner .notice=${notice([])} .signInRun=${run} .loginHere=${true} .permission=${null}></acp-session-banner>`,
      );
      const { banner, buttons, names } = view(el);
      expect(banner.label).to.equal('Signing in to Codex… Finish in the Copilot Login terminal.');
      expect(names).to.deep.equal(['Show terminal', 'Cancel']);
      const seen = events(el);
      buttons[0].click();
      expect(seen).to.deep.equal([['acp-session-action', { action: 'show-login' }]]);
    });

    it("doesn't offer a login's terminal another window started", async () => {
      const terminal = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: 'copilot login' };
      const run = { state: /** @type {const} */ ('waiting'), message: null, terminal };
      const el = await fixture(html`<acp-session-banner .notice=${notice([])} .signInRun=${run} .permission=${null}></acp-session-banner>`);
      const { banner, names } = view(el);
      expect(banner.label).to.equal('Signing in to Codex… Finish in the Copilot Login terminal of the window that started it.');
      expect(names).to.deep.equal(['Cancel']);
    });

    it('says a sign-in runs, with Cancel', async () => {
      const run = { state: /** @type {const} */ ('waiting'), message: null, terminal: null };
      const el = await fixture(
        html`<acp-session-banner .notice=${notice([method({ id: 'chat-gpt', name: 'ChatGPT' })])} .signInRun=${run} .permission=${null}></acp-session-banner>`,
      );
      const { banner, buttons, names } = view(el);
      expect(banner.label).to.equal('Signing in to Codex… Finish in your browser if it opened.');
      expect(names).to.deep.equal(['Cancel']);
      const seen = events(el);
      buttons[0].click();
      expect(seen).to.deep.equal([['acp-agent-sign-in-cancel', { agentId: 'codex' }]]);
    });

    it('says why a sign-in failed and offers it again', async () => {
      const run = { state: /** @type {const} */ ('failed'), message: 'login failed', terminal: null };
      const el = await fixture(
        html`<acp-session-banner .notice=${notice([method({ id: 'chat-gpt', name: 'ChatGPT' })])} .signInRun=${run} .permission=${null}></acp-session-banner>`,
      );
      const { banner, names } = view(el);
      expect(banner.label).to.equal('Signing in to Codex failed: login failed');
      expect(banner.variant).to.equal('danger');
      expect(names).to.deep.equal(['ChatGPT', 'Retry']);
    });
  });
});
