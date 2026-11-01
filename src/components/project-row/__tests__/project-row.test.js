import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../project-row.js';

/** @typedef {import('../project-row.js').AcpProjectRow} AcpProjectRow */

const PROJECT = { id: '/home/me/brama', name: 'brama', path: '/home/me/brama' };

/** @param {Partial<AcpProjectRow>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpProjectRow} */ (await fixture(html`<acp-project-row></acp-project-row>`));
  Object.assign(el, { project: PROJECT, path: '~/brama', ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, row: /** @type {HTMLElement} */ (root.querySelector('.acp-project-row__row')) };
}

/**
 * @param {Element} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

describe('acp-project-row', () => {
  it('shows the name, the path with its full form in a tooltip, and the count only while collapsed', async () => {
    const open = await render({ count: 3, active: true });
    expect(open.root.querySelector('.acp-project-row__name')?.textContent?.trim()).to.equal('brama');
    expect(open.root.querySelector('.acp-project-row__name_active'), 'the open project').to.not.equal(null);
    expect(open.root.querySelector('.acp-project-row__path')?.textContent).to.equal('~/brama');
    expect(tooltipOf(open.root.querySelector('.acp-project-row__path'))).to.equal('/home/me/brama');
    expect(tooltipOf(open.root.querySelector('.acp-project-row__add'))).to.equal('New session');
    expect(open.row.getAttribute('aria-expanded')).to.equal('true');
    expect(open.root.querySelector('.acp-project-row__count'), 'expanded: no count').to.equal(null);
    expect(open.root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);

    const closed = await render({ count: 3, expanded: false });
    expect(closed.row.getAttribute('aria-expanded')).to.equal('false');
    expect(closed.root.querySelector('.acp-project-row__count')?.textContent).to.equal('3');
    expect((await render({ count: 0, expanded: false })).root.querySelector('.acp-project-row__count'), 'none to count').to.equal(null);
  });

  it('is a tree item at level 1 that is a Tab stop only while it holds the tree\'s, and focuses itself', async () => {
    const { el, row } = await render();
    expect([row.getAttribute('role'), row.getAttribute('aria-level'), row.tabIndex]).to.deep.equal(['treeitem', '1', 0]);
    el.tabStop = false;
    await el.updateComplete;
    expect(row.tabIndex).to.equal(-1);
    el.focusRow();
    expect(el.shadowRoot?.activeElement).to.equal(row);
  });

  it('selects on a click or Enter, starts a session with its button without selecting, and asks for its menu at the pointer or under the row', async () => {
    const { el, root, row } = await render();
    const selects = record(el, 'acp-project-select');
    const news = record(el, 'acp-project-new-session');
    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(selects).to.have.length(2);
    /** @type {HTMLElement} */ (root.querySelector('.acp-project-row__add')).click();
    expect(news.map((e) => e.detail)).to.deep.equal([{ projectId: '/home/me/brama' }]);
    expect(selects, 'the button does not select').to.have.length(2);

    const menus = record(el, 'acp-project-row-menu');
    const click = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 3, clientY: 4 });
    row.dispatchEvent(click);
    expect(click.defaultPrevented).to.equal(true);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, cancelable: true }));
    expect([menus[0].detail.x, menus[0].detail.y], 'at the pointer').to.deep.equal([3, 4]);
    const rect = row.getBoundingClientRect();
    expect([menus[1].detail.x, menus[1].detail.y], 'under the row').to.deep.equal([rect.left + 24, rect.bottom]);
    expect(menus[1].detail.project).to.equal(PROJECT);
  });
});
