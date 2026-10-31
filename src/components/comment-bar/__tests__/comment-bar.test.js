import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../comment-bar.js';

/** @typedef {import('../../../models/types/types.js').QueuedComment} QueuedComment */

/** @type {QueuedComment} */
const COMMENT = { path: '/p/a.js', threadId: 't1', commentId: 'c1', fromLine: 1, line: 1, lineText: 'a', body: 'Fix it' };

describe('acp-comment-bar', () => {
  it('names its arrows in tooltips, not titles', async () => {
    const el = await fixture(html`<acp-comment-bar .comments=${[COMMENT]}></acp-comment-bar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect([...root.querySelectorAll('.acp-comment-bar__nav')].map(tooltipOf)).to.deep.equal(['Previous', 'Next']);
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
