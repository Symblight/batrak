import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-changes-review.js';

/** @typedef {import('../../../models/types.js').GitFileStatus} GitFileStatus */

/** @type {GitFileStatus} */
const RENAMED = { path: 'src/b.js', kind: 'renamed', staged: false, unstaged: true, origPath: 'src/a.js', added: 1, removed: 0 };

describe('acp-changes-review', () => {
  it("shows each file's path, rename and actions in tooltips, not titles", async () => {
    const el = await fixture(html`<acp-changes-review
      .changes=${{ files: [RENAMED], loaded: true, loading: false, error: null }}
      .repo=${{ repo: { branch: 'main', sha: 'abc', detached: false, upstream: null, ahead: 0, behind: 0 }, error: null }}
      .expanded=${new Set(['src/b.js'])}
      .root=${'/p'}
    ></acp-changes-review>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('.acp-changes-review__name'))).to.equal('src/b.js');
    expect(tooltipOf(root.querySelector('.acp-changes-review__renamed'))).to.equal('Renamed from src/a.js');
    expect([...root.querySelectorAll('.acp-changes-review__action')].map(tooltipOf)).to.deep.equal(['Edit', 'Not available yet']);
    expect(tooltipOf(root.querySelector('.acp-changes-review__tool'))).to.equal('Collapse all');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it("explains a session's Apply and Check out in tooltips", async () => {
    const el = await fixture(html`<acp-changes-review
      .changes=${{ files: [RENAMED], loaded: true, loading: false, error: null }}
      .root=${'/p'}
      .base=${'abc1234def'}
      .branch=${'brama/fix-1'}
    ></acp-changes-review>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect([...root.querySelectorAll('.acp-changes-review__session-action')].map(tooltipOf)).to.deep.equal([
      'Bring the changes into the project, unstaged',
      'Check brama/fix-1 out in the project',
    ]);
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
