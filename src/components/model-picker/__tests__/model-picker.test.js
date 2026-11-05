import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../model-picker.js';

/** @typedef {import('../../../hooks/composer/types.js').ConfigOption} ConfigOption */

/** @type {ConfigOption} */
const MODEL = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'opus',
  options: [
    { value: 'opus', name: 'Opus', description: 'Most capable' },
    { value: 'sonnet', name: 'Sonnet', description: 'Sonnet' },
  ],
};

/** @type {ConfigOption} */
const LEVEL = {
  id: 'effort',
  name: 'Thinking',
  category: 'thought_level',
  type: 'select',
  currentValue: 'high',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};

/** @type {ConfigOption} */
const MODE = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Ask' }],
};

/** @type {ConfigOption} */
const ALLOW_ALL = {
  id: 'allow_all',
  name: 'Allow All',
  category: 'permissions',
  type: 'select',
  currentValue: 'off',
  options: [
    { value: 'on', name: 'On' },
    { value: 'off', name: 'Off' },
  ],
};

const ALL = [MODEL, LEVEL, MODE, ALLOW_ALL];

/** @param {Element} el */
function rootOf(el) {
  return /** @type {ShadowRoot} */ (el.shadowRoot);
}

/** @param {Element} el */
function buttonOf(el) {
  return /** @type {HTMLElement & { disabled: boolean }} */ (rootOf(el).querySelector('#acp-model-picker-button'));
}

describe('acp-model-picker', () => {
  it('shows the model and the level on its button', async () => {
    const el = await fixture(html`<acp-model-picker .options=${ALL}></acp-model-picker>`);
    const text = buttonOf(el).textContent?.replace(/\s+/g, ' ');
    expect(text).to.contain('Opus');
    expect(text).to.contain('High');
    expect(buttonOf(el).disabled).to.equal(false);
    expect(tooltipOf(buttonOf(el))).to.equal('Model: Opus · Thinking: High');
    expect(rootOf(el).querySelector('[title]')).to.equal(null);
  });

  it('groups the model and the level, not the mode or the permissions', async () => {
    const el = await fixture(html`<acp-model-picker .options=${ALL}></acp-model-picker>`);
    const groups = [...rootOf(el).querySelectorAll('md-menu-group')].map((g) => g.getAttribute('label'));
    expect(groups).to.deep.equal(['Model', 'Thinking']);
    const selected = [...rootOf(el).querySelectorAll('md-menu-item[selected]')].map((i) => i.getAttribute('value'));
    expect(selected).to.deep.equal(['opus', 'high']);
    expect(rootOf(el).querySelector('md-menu md-menu')).to.equal(null);
  });

  it('picks a value of an option', async () => {
    const el = await fixture(html`<acp-model-picker .options=${ALL}></acp-model-picker>`);
    const menu = /** @type {HTMLElement} */ (rootOf(el).querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (rootOf(el).querySelector('md-menu-item[value="sonnet"]'));
    /** @type {unknown[]} */
    const picked = [];
    el.addEventListener('acp-config-option', (/** @type {Event} */ e) => picked.push(/** @type {CustomEvent} */ (e).detail));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: 'sonnet', item } }));
    expect(picked).to.deep.equal([{ configId: 'model', value: 'sonnet' }]);
  });

  it('shows a description only when it says more than the name', async () => {
    const el = await fixture(html`<acp-model-picker .options=${ALL}></acp-model-picker>`);
    const opus = /** @type {HTMLElement} */ (rootOf(el).querySelector('md-menu-item[value="opus"]'));
    const sonnet = /** @type {HTMLElement} */ (rootOf(el).querySelector('md-menu-item[value="sonnet"]'));
    expect(opus.querySelector('[slot="supporting-text"]')?.textContent?.trim()).to.equal('Most capable');
    expect(sonnet.querySelector('[slot="supporting-text"]')).to.equal(null);
  });

  it('shows the state of the models: loading, refreshing, failed, signing in, or nothing to pick', async () => {
    /** @type {[string, ConfigOption[], Record<string, unknown>, { disabled?: boolean, text?: string, spinner?: boolean, tooltip?: string }][]} */
    const cases = [
      ['loading', [MODE], { status: 'loading' }, { disabled: true, text: 'Loading models…', spinner: true, tooltip: 'Asking the agent' }],
      ['refreshing known models', ALL, { status: 'loading' }, { disabled: false, text: 'Opus', spinner: true }],
      [
        'failed',
        [],
        { status: 'failed' },
        { disabled: true, text: 'No models', spinner: false, tooltip: "Couldn't load models from the agent; they show once its session starts" },
      ],
      ['sign-in needed', [], { signIn: true }, { disabled: true, text: 'Sign in to load models', spinner: false }],
    ];
    for (const [why, options, props, want] of cases) {
      // Arrange
      const el = /** @type {HTMLElement} */ (await fixture(html`<acp-model-picker .options=${options}></acp-model-picker>`));
      // Act
      Object.assign(el, props);
      await /** @type {import('lit').LitElement} */ (/** @type {unknown} */ (el)).updateComplete;
      // Assert
      expect(buttonOf(el).disabled, why).to.equal(want.disabled);
      expect(buttonOf(el).textContent, why).to.contain(want.text);
      expect(rootOf(el).querySelector('md-progress-circular') !== null, `${why}: spinner`).to.equal(want.spinner);
      if (want.tooltip) expect(tooltipOf(buttonOf(el)), why).to.contain(want.tooltip);
    }

    const none = await fixture(html`<acp-model-picker .options=${[MODE, ALLOW_ALL]}></acp-model-picker>`);
    expect(rootOf(none).querySelector('md-button'), 'nothing to pick, nothing loading').to.equal(null);
  });
});
