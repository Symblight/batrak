import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../model-picker.js';

/** @typedef {import('../../../models/types/types.js').ConfigOption} ConfigOption */

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

  it('is disabled with a spinner while the models load', async () => {
    const el = await fixture(html`<acp-model-picker .options=${[MODE]} .status=${'loading'}></acp-model-picker>`);
    expect(buttonOf(el).disabled).to.equal(true);
    expect(buttonOf(el).textContent).to.contain('Loading models…');
    expect(rootOf(el).querySelector('md-progress-circular')).to.not.equal(null);
    expect(tooltipOf(buttonOf(el))).to.contain('Asking the agent');
  });

  it('stays usable while known models refresh', async () => {
    const el = await fixture(html`<acp-model-picker .options=${ALL} .status=${'loading'}></acp-model-picker>`);
    expect(buttonOf(el).disabled).to.equal(false);
    expect(buttonOf(el).textContent).to.contain('Opus');
    expect(rootOf(el).querySelector('md-progress-circular')).to.not.equal(null);
  });

  it('says when the models could not be loaded', async () => {
    const el = await fixture(html`<acp-model-picker .options=${[]} .status=${'failed'}></acp-model-picker>`);
    expect(buttonOf(el).disabled).to.equal(true);
    expect(buttonOf(el).textContent).to.contain('No models');
    expect(tooltipOf(buttonOf(el))).to.equal("Couldn't load models from the agent; they show once its session starts");
  });

  it('asks to sign in before the models can load', async () => {
    const el = await fixture(html`<acp-model-picker .options=${[]} .signIn=${true}></acp-model-picker>`);
    expect(buttonOf(el).disabled).to.equal(true);
    expect(buttonOf(el).textContent).to.contain('Sign in to load models');
  });

  it('renders nothing with no options and nothing loading', async () => {
    const el = await fixture(html`<acp-model-picker .options=${[MODE, ALLOW_ALL]}></acp-model-picker>`);
    expect(rootOf(el).querySelector('md-button')).to.equal(null);
  });
});
