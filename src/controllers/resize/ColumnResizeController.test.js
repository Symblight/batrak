import { expect } from '@esm-bundle/chai';
import { LitElement, html } from 'lit';
import { atom } from 'nanostores';
import { ColumnResizeController } from './ColumnResizeController.js';

/** @typedef {import('../../models/types.js').ColumnWidths} ColumnWidths */

const store = atom(/** @type {ColumnWidths} */ ({}));

class TestColumns extends LitElement {
  resize = new ColumnResizeController(this, {
    store,
    columns: {
      left: { property: '--test-left-width', min: 100, max: 500, partner: 'right' },
      right: { property: '--test-right-width', min: 100, max: 900 },
    },
  });

  render() {
    return html`
      <div class="left" style=${this.resize.columnStyle('left')}></div>
      <div class="right" style=${this.resize.columnStyle('right')}></div>
    `;
  }
}
customElements.define('test-columns', TestColumns);

/** @param {string} name */
const column = (/** @type {TestColumns} */ host, name) =>
  /** @type {HTMLElement} */ (host.renderRoot.querySelector(`.${name}`));

describe('ColumnResizeController', () => {
  /** @type {TestColumns} */
  let host;

  beforeEach(async () => {
    store.set({});
    document.documentElement.style.setProperty('--test-left-width', '200px');
    document.documentElement.style.setProperty('--test-right-width', '600px');
    host = /** @type {TestColumns} */ (document.createElement('test-columns'));
    document.body.append(host);
    await host.updateComplete;
  });

  afterEach(() => {
    host.remove();
    document.documentElement.style.removeProperty('--test-left-width');
    document.documentElement.style.removeProperty('--test-right-width');
  });

  it("sizes each column inline, at its property's default", () => {
    expect(column(host, 'left').style.flexBasis).to.equal('200px');
    expect(column(host, 'left').style.width).to.equal('200px');
    expect(column(host, 'right').style.width).to.equal('600px');
  });

  it('moves width between the column and its partner inline, never through a custom property on the host', async () => {
    const measure = { width: 200, neighborWidth: 600, neighborMin: 0 };
    host.dispatchEvent(new CustomEvent('acp-resize-start', { detail: { name: 'left', measure } }));
    host.dispatchEvent(new CustomEvent('acp-resize', { detail: { name: 'left', delta: 50 } }));
    await host.updateComplete;

    expect(column(host, 'left').style.width).to.equal('250px');
    expect(column(host, 'right').style.width).to.equal('550px');
    expect(host.style.getPropertyValue('--test-left-width')).to.equal('');
    expect(host.style.getPropertyValue('--test-right-width')).to.equal('');
    expect(store.get()).to.deep.equal({});

    host.dispatchEvent(new CustomEvent('acp-resize-end', { detail: { name: 'left' } }));
    expect(store.get()).to.deep.equal({ left: 250, right: 550 });
  });

  it('applies stored widths inline', async () => {
    store.set({ left: 320 });
    await host.updateComplete;
    expect(column(host, 'left').style.width).to.equal('320px');
  });
});
