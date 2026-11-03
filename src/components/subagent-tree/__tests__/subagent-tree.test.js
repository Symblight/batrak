import { expect, fixture, html } from '../../../../test/fixture.js';
import '../subagent-tree.js';

/** @typedef {import('../../../hooks/sessions/types.js').Subagent} Subagent */
/** @typedef {HTMLElementTagNameMap['acp-subagent-tree']} AcpSubagentTree */

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

/**
 * @param {string} id
 * @param {Partial<Subagent>} [fields]
 * @returns {Subagent}
 */
const subagent = (id, fields = {}) => ({
  id,
  title: `Task ${id}`,
  description: 'Explore',
  state: 'running',
  stopReason: null,
  cancellable: true,
  announcedAt: '2026-11-03T11:57:00.000Z',
  ...fields,
});

/** @param {Subagent[]} subagents */
async function render(subagents) {
  /** @type {AcpSubagentTree} */
  const el = await fixture(html`<acp-subagent-tree .sessionId=${'s1'} .subagents=${subagents} .now=${NOW}></acp-subagent-tree>`);
  const tree = /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (el.shadowRoot?.querySelector('tvx-tree-view'));
  await tree.updateComplete;
  /** The tree's rows: their text, status label and element. */
  const rows = () =>
    [...(tree.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? [])].map((row) => ({
      row: /** @type {HTMLElement} */ (row),
      text: row.textContent?.replace(/\s+/g, ' ').trim(),
      status: row.querySelector('[data-status]')?.getAttribute('aria-label') ?? null,
    }));
  return { el, tree, rows };
}

describe('acp-subagent-tree', () => {
  it('shows "N agents" collapsed; expanded, each subagent with its kind, title, status and age', async () => {
    // Arrange
    const { tree, rows } = await render([
      subagent('a'),
      subagent('b', { state: 'requires_action' }),
      subagent('c', { state: 'idle', stopReason: 'end_turn', description: null }),
      subagent('d', { state: 'idle', stopReason: 'error' }),
      subagent('e', { state: 'idle', stopReason: 'cancelled' }),
    ]);
    expect(rows().map((r) => r.text)).to.deep.equal(['5 agents']);
    // Act
    tree.expansion.expandAll();
    await tree.updateComplete;
    // Assert
    expect(rows().slice(1).map((r) => [r.text, r.status])).to.deep.equal([
      ['Explore · Task a 3m', 'Working'],
      ['Explore · Task b waiting', 'Waiting for you'],
      ['Task c 3m', 'Done'],
      ['Explore · Task d 3m', 'Failed'],
      ['Explore · Task e 3m', 'Stopped'],
    ]);
  });

  it("opens a subagent's chat when its row is picked; the \"N agents\" row only toggles", async () => {
    // Arrange
    const { el, tree, rows } = await render([subagent('a'), subagent('b')]);
    /** @type {unknown[]} */
    const opened = [];
    el.addEventListener('acp-subagent-open', (e) => opened.push(/** @type {CustomEvent} */ (e).detail));
    // Act
    rows()[0].row.click();
    await tree.updateComplete;
    rows()[2].row.click();
    // Assert
    expect(rows().length, 'the branch click expanded it').to.equal(3);
    expect(opened).to.deep.equal([{ sessionId: 's1', subagentId: 'b' }]);
  });
});
