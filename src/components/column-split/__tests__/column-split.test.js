import { expect, fixture, html } from '../../../../test/fixture.js';
import '../column-split.js';

/** @typedef {import('../column-split.js').AcpColumnSplit} AcpColumnSplit */

/** @type {import('../column-split.js').SplitColumn[]} */
const COLUMNS = [
  { name: 'a', size: '--t-a-width', minSize: '--t-a-min', shrink: 1, collapse: 'end', resize: { min: 100, max: 400, partner: 'b', label: 'Resize a' } },
  { name: 'b', size: '--t-b-width', minSize: '--t-b-min', shrink: 1000, resize: { min: 100, max: 800, label: 'Resize b' } },
  { name: 'c', minSize: '--t-c-min' },
  { name: 'd', size: '--t-d-width', collapse: 'start', resize: { min: 100, max: 400, label: 'Resize d', edge: 'start' } },
];

/** What is laid out, in order: `pane:<column>` and `handle:<column>`, `-hidden` for a collapsed pane. */
const layoutOf = (/** @type {AcpColumnSplit} */ el) =>
  [...(el.shadowRoot?.querySelector('acp-split')?.children ?? [])].flatMap((child) => {
    if (child.localName === 'acp-resize-handle') return [`handle:${child.getAttribute('name')}`];
    if (child.localName !== 'acp-pane') return [];
    return [`pane:${child.querySelector('slot')?.name}${child.hasAttribute('hidden') ? '-hidden' : ''}`];
  });

describe('acp-column-split', () => {
  before(() => {
    for (const [property, value] of [['--t-a-width', '200px'], ['--t-b-width', '600px'], ['--t-d-width', '250px'], ['--t-a-min', '100px'], ['--t-b-min', '100px'], ['--t-c-min', '100px']]) {
      document.documentElement.style.setProperty(property, value);
    }
  });

  after(() => {
    for (const property of ['--t-a-width', '--t-b-width', '--t-d-width', '--t-a-min', '--t-b-min', '--t-c-min']) {
      document.documentElement.style.removeProperty(property);
    }
  });

  /** @param {Partial<Pick<AcpColumnSplit, 'hiddenColumns' | 'fillColumns' | 'widths'>>} [props] */
  async function render(props = {}) {
    const el = /** @type {AcpColumnSplit} */ (
      await fixture(html`<acp-column-split
        .columns=${COLUMNS}
        .hiddenColumns=${props.hiddenColumns ?? []}
        .fillColumns=${props.fillColumns ?? []}
        .widths=${props.widths ?? {}}
      ></acp-column-split>`)
    );
    await el.updateComplete;
    return el;
  }

  const pane = (/** @type {AcpColumnSplit} */ el, /** @type {string} */ name) =>
    /** @type {HTMLElement} */ ([...(el.shadowRoot?.querySelectorAll('acp-pane') ?? [])].find((p) => p.querySelector('slot')?.name === name));

  it('lays out a pane per column with a divider beside each resizable one that has a width of its own', async () => {
    // Arrange / Act
    const el = await render();

    // Assert
    expect(layoutOf(el), 'all shown').to.deep.equal(['pane:a', 'handle:a', 'pane:b', 'handle:b', 'pane:c', 'handle:d', 'pane:d']);
    expect(pane(el, 'a').style.width, 'a at its default').to.equal('200px');
    expect(pane(el, 'a').getAttribute('edge')).to.equal('end');

    // Act
    el.hiddenColumns = ['a', 'c'];
    el.fillColumns = ['b'];
    await el.updateComplete;

    // Assert
    expect(layoutOf(el), 'hidden and filling columns lose their divider').to.deep.equal(['pane:a-hidden', 'pane:b', 'pane:c-hidden', 'handle:d', 'pane:d']);
    expect(pane(el, 'a').style.width, 'hidden: no inline width, so it collapses to nothing').to.equal('');
    expect(pane(el, 'b').style.getPropertyValue('--acp-pane-flex'), 'filling: takes the slack').to.equal('1');
    expect(pane(el, 'b').style.width).to.equal('');
  });

  it('applies the widths it is given, and reports the widths a drag ends on', async () => {
    // Arrange
    const el = await render({ widths: { d: 320 } });
    expect(pane(el, 'd').style.width, 'given').to.equal('320px');
    /** @type {unknown[]} */
    const reported = [];
    el.addEventListener('acp-columns-resize', (e) => reported.push(/** @type {CustomEvent} */ (e).detail));
    const handle = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('acp-resize-handle[name="a"]'));
    const measure = { width: 200, neighborWidth: 600, neighborMin: 0 };

    // Act
    for (const [type, detail] of /** @type {const} */ ([['acp-resize-start', { name: 'a', measure }], ['acp-resize', { name: 'a', delta: 50 }], ['acp-resize-end', { name: 'a' }]])) {
      handle.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }
    await el.updateComplete;

    // Assert
    expect(reported).to.deep.equal([{ widths: { d: 320, a: 250, b: 550 } }]);
    expect(pane(el, 'b').style.width, 'its partner gave the width').to.equal('550px');
  });
});
