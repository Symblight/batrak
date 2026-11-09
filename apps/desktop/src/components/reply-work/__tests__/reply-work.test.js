import { expect, fixture, html } from '../../../../test/fixture.js';
import '../reply-work.js';

/** @typedef {import('../reply-work.js').AcpReplyWork} AcpReplyWork */
/** @typedef {import('../../../hooks/sessions/types.js').ToolCallView} ToolCallView */
/** @typedef {import('../../../hooks/sessions/types.js').WorkStep} WorkStep */

/**
 * @param {string} toolCallId
 * @param {Partial<ToolCallView>} [fields]
 * @returns {WorkStep}
 */
const tool = (toolCallId, fields = {}) => ({
  kind: 'tool',
  call: {
    toolCallId,
    label: `Call ${toolCallId}`,
    command: `cmd ${toolCallId}`,
    kind: 'execute',
    status: 'completed',
    locations: [],
    error: '',
    diff: null,
    startedAt: null,
    endedAt: null,
    ...fields,
  },
});

/**
 * @param {WorkStep[]} steps
 * @param {boolean} live
 */
async function work(steps, live) {
  return /** @type {Promise<AcpReplyWork>} */ (fixture(html`<acp-reply-work .steps=${steps} ?live=${live}></acp-reply-work>`));
}

/** @param {AcpReplyWork} el */
const head = (el) => /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-reply-work__head'));
/** @param {AcpReplyWork} el */
const headText = (el) => head(el).textContent?.replace(/\s+/g, ' ').trim();
/** @param {AcpReplyWork} el */
const shownSteps = (el) => [...(el.shadowRoot?.querySelector('.acp-reply-work__steps')?.children ?? [])];
/** @param {AcpReplyWork} el */
const spinner = (el) => el.shadowRoot?.querySelector('md-progress-circular') ?? null;

describe('acp-reply-work', () => {
  it('while a call runs, shows one line: the running call with a spinner and the time; between calls, the summary so far', async () => {
    // Arrange
    const t0 = Date.now() - 34_000;
    const steps = [tool('1', { label: 'List files', startedAt: t0, endedAt: t0 + 2000 }), tool('2', { label: 'Run the tests', status: 'in_progress', startedAt: t0 + 3000 })];
    // Act
    const el = await work(steps, true);
    // Assert
    expect(headText(el)).to.equal('Running the tests 34s');
    expect(spinner(el)).to.not.equal(null);

    // Act
    el.steps = [steps[0], tool('2', { label: 'Run the tests', startedAt: t0 + 3000, endedAt: t0 + 4000 })];
    await el.updateComplete;
    // Assert
    expect(headText(el), 'between calls: until the last call ended').to.equal('Ran 2 commands 4s');
    expect(spinner(el), 'nothing runs').to.equal(null);

    // Act
    el.steps = [steps[0], tool('2', { label: 'Edit a.txt', status: 'awaiting-permission' })];
    await el.updateComplete;
    // Assert
    expect(headText(el)).to.match(/^Waiting for permission: Edit a.txt/);
  });

  it('once done, says what the reply did and how long it took', async () => {
    // Arrange
    const t0 = 1_000_000;
    /** @type {WorkStep[]} */
    const steps = [
      tool('1', { status: 'failed', startedAt: t0, endedAt: t0 + 2000 }),
      tool('2', { kind: 'edit', locations: [{ path: 'AGENTS.md' }], diff: { added: 52, removed: 0, created: true }, startedAt: t0 + 3000, endedAt: t0 + 34_000 }),
      tool('3', { startedAt: t0 + 4000, endedAt: t0 + 5000 }),
    ];
    // Act
    const el = await work(steps, false);
    // Assert
    expect(headText(el)).to.equal('Ran 2 commands, created AGENTS.md · 1 failed 34s');
    const counts = /** @type {import('../../diff-counts/diff-counts.js').AcpDiffCounts} */ (el.shadowRoot?.querySelector('acp-diff-counts'));
    expect([counts.added, counts.removed, spinner(el)]).to.deep.equal([52, 0, null]);
  });

  it('expands to its steps and collapses again, on a click or Enter, live or done', async () => {
    for (const live of [true, false]) {
      // Arrange
      const el = await work([tool('1'), tool('2')], live);
      // Act + Assert
      expect(shownSteps(el), 'collapsed').to.have.length(0);
      head(el).click();
      await el.updateComplete;
      expect([shownSteps(el).length, head(el).getAttribute('aria-expanded')], `live ${live}`).to.deep.equal([2, 'true']);
      head(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await el.updateComplete;
      expect([shownSteps(el).length, head(el).getAttribute('aria-expanded')], `live ${live}`).to.deep.equal([0, 'false']);
    }
  });

  it('lists only its tool calls, each worded by what it did with its file and counts, opening to its error and command', async () => {
    // Arrange
    const el = await work(
      [
        tool('1', { label: 'List files', command: 'ls -la', status: 'failed', error: 'boom' }),
        tool('2', { label: 'Write', command: '', kind: 'edit', locations: [{ path: 'src/a.rs' }], diff: { added: 59, removed: 0, created: true } }),
      ],
      false,
    );
    const text = (/** @type {Element} */ node) => node.textContent?.replace(/\s+/g, ' ').trim();
    // Act
    head(el).click();
    await el.updateComplete;
    // Assert
    const [failed, created] = shownSteps(el);
    expect(shownSteps(el).map(text), 'the failed call as asked').to.deep.equal(['List files', 'Created a.rs']);
    const counts = /** @type {import('../../diff-counts/diff-counts.js').AcpDiffCounts} */ (created.querySelector('acp-diff-counts'));
    expect([counts.added, counts.removed]).to.deep.equal([59, 0]);

    // Act
    /** @type {HTMLElement} */ (failed.querySelector('[role="button"]')).click();
    await el.updateComplete;
    // Assert
    expect(text(failed)).to.equal('List files boom ls -la');
    expect(el.expanded, 'the work row stays open').to.equal(true);
  });

  it('opens the file of a summary’s chip, without expanding', async () => {
    // Arrange
    const el = await work([tool('1', { kind: 'read', locations: [{ path: 'src/a.rs', line: 3 }] }), tool('2')], false);
    /** @type {unknown[]} */
    const opened = [];
    el.addEventListener('acp-tool-location-click', (e) => opened.push(/** @type {CustomEvent} */ (e).detail));
    // Act
    /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-reply-work__file')).click();
    await el.updateComplete;
    // Assert
    expect(opened).to.deep.equal([{ path: 'src/a.rs', line: 3 }]);
    expect(shownSteps(el), 'still collapsed').to.have.length(0);
  });
});
