import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../mode-picker.js';

/** @typedef {import('../../../hooks/composer/types.js').ConfigOption} ConfigOption */

/** @type {ConfigOption[]} */
const OPTIONS = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Ask' },
      { value: 'full', name: 'Full access' },
    ],
  },
];

describe('acp-mode-picker', () => {
  it("takes a mode's risk from its tag, never from its name: the agent's crate knows its modes", async () => {
    /** @type {ConfigOption[]} */
    const options = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'careful',
        options: [
          { value: 'careful', name: 'Careful', risk: 'neutral' },
          { value: 'yolo', name: 'Yolo', risk: 'full' },
          { value: 'bypassPermissions', name: 'Untagged' },
        ],
      },
    ];
    const el = /** @type {import('../mode-picker.js').AcpModePicker} */ (await fixture(html`<acp-mode-picker .options=${options}></acp-mode-picker>`));
    const danger = [...(el.shadowRoot?.querySelectorAll('.acp-mode-picker__item_danger') ?? [])].map((i) => i.getAttribute('value'));
    expect(danger).to.deep.equal(['yolo']);
  });

  it('names the option and its value in a tooltip, not a title', async () => {
    const el = await fixture(html`<acp-mode-picker .options=${OPTIONS}></acp-mode-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('#acp-mode-picker-button'))).to.equal('Mode: Ask');
    expect(root.querySelector('[title]')).to.equal(null);
  });
});

describe('acp-mode-picker permissions', () => {
  /** @type {ConfigOption} */
  const ALLOW_ALL = {
    id: 'allow_all',
    name: 'Allow All',
    category: 'permissions',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'on', name: 'On', description: 'On' },
      { value: 'off', name: 'Off' },
    ],
  };

  it('offers the permissions options below the modes', async () => {
    const el = await fixture(html`<acp-mode-picker .options=${[...OPTIONS, ALLOW_ALL]}></acp-mode-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const groups = [...root.querySelectorAll('md-menu-group')].map((g) => g.getAttribute('label'));
    expect(groups).to.deep.equal(['Mode', 'Allow All']);
    const off = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[data-config="allow_all"][value="off"]'));
    expect(off.hasAttribute('selected')).to.equal(true);
    const on = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[data-config="allow_all"][value="on"]'));
    expect(on.querySelector('[slot="supporting-text"]')).to.equal(null);
  });

  it('picks a permissions value', async () => {
    const el = await fixture(html`<acp-mode-picker .options=${[...OPTIONS, ALLOW_ALL]}></acp-mode-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[data-config="allow_all"][value="on"]'));
    /** @type {unknown[]} */
    const picked = [];
    el.addEventListener('acp-config-option', (/** @type {Event} */ e) => picked.push(/** @type {CustomEvent} */ (e).detail));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: 'on', item } }));
    expect(picked).to.deep.equal([{ configId: 'allow_all', value: 'on' }]);
  });

  it('still picks a mode', async () => {
    const el = await fixture(html`<acp-mode-picker .options=${[...OPTIONS, ALLOW_ALL]}></acp-mode-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[value="full"]'));
    /** @type {unknown[]} */
    const picked = [];
    el.addEventListener('acp-config-option', (/** @type {Event} */ e) => picked.push(/** @type {CustomEvent} */ (e).detail));
    menu.dispatchEvent(new CustomEvent('select', { detail: { value: 'full', item } }));
    expect(picked).to.deep.equal([{ configId: 'mode', value: 'full' }]);
  });

  it('shows the chip for a permissions option with no mode', async () => {
    const el = await fixture(html`<acp-mode-picker .options=${[ALLOW_ALL]}></acp-mode-picker>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('.acp-mode-picker__label')?.textContent?.trim()).to.equal('Allow All: Off');
    expect(tooltipOf(root.querySelector('#acp-mode-picker-button'))).to.equal('Allow All: Off');
  });
});
