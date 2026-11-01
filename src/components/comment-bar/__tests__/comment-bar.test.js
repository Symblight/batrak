import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../comment-bar.js';

/** @typedef {import('../../../hooks/comments/types.js').QueuedComment} QueuedComment */

/** @type {QueuedComment} */
const COMMENT = { path: '/p/a.js', threadId: 't1', commentId: 'c1', fromLine: 1, line: 1, lineText: 'a', body: 'Fix it' };

describe('acp-comment-bar', () => {
  it('floats over a file tab unless placed over the Changes tab, and says which in an attribute', async () => {
    const el = await fixture(html`<acp-comment-bar .comments=${[COMMENT]}></acp-comment-bar>`);
    expect(el.getAttribute('placement')).to.equal('file');
    el.placement = 'changes';
    await el.updateComplete;
    expect(el.getAttribute('placement')).to.equal('changes');
  });

  it('names its arrows in tooltips, not titles', async () => {
    const el = await fixture(html`<acp-comment-bar .comments=${[COMMENT]}></acp-comment-bar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect([...root.querySelectorAll('.acp-comment-bar__nav')].map(tooltipOf)).to.deep.equal(['Previous', 'Next']);
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
