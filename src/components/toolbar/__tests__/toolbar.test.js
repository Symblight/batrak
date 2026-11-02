import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../toolbar.js';

/** @typedef {import('../../../hooks/git/types.js').GitRepoView} GitRepoView */

/** @type {GitRepoView} */
const GIT = {
  repo: { branch: 'main', sha: 'abc1234def', detached: false, upstream: 'origin/main', ahead: 2, behind: 0, upstreamSha: null, remote: null, hasRemotes: false, fetchedAt: null },
  error: null,
};

/** @type {import('../../../hooks/git/types.js').GitRemoteOp} */
const OP = { rootId: 'r1', action: 'push', state: 'running', error: null };

/** @type {import('../../../hooks/github/types.js').GithubPrReply} */
const REPLY = { status: 'ok', pr: null, defaultBranch: 'main', message: null };

describe('acp-toolbar', () => {
  it("shows the project's path and the branch state in tooltips, not titles", async () => {
    const el = await fixture(html`<acp-toolbar
      .workspace=${{ path: '/work/app', name: 'app', rootId: 'r1' }}
      .git=${GIT}
      .remoteOp=${OP}
      .githubSlot=${'ok'}
      .githubReply=${REPLY}
    ></acp-toolbar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('.acp-toolbar__name'))).to.equal('/work/app');
    expect(tooltipOf(root.querySelector('.acp-toolbar__branch'))).to.equal('Branch main, tracking origin/main');
    const chip = root.querySelector('acp-remote-chip');
    expect([chip?.repo, chip?.op], 'the sync state is the chip\'s').to.deep.equal([GIT.repo, OP]);
    const slot = root.querySelector('acp-pull-request-chip');
    expect([slot?.status, slot?.reply, slot?.repo], 'GitHub slot').to.deep.equal(['ok', REPLY, GIT.repo]);
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('says why git is unavailable in a tooltip', async () => {
    const el = await fixture(html`<acp-toolbar
      .workspace=${{ path: '/work/app', name: 'app', rootId: 'r1' }}
      .git=${{ repo: null, error: 'git not found' }}
    ></acp-toolbar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('.acp-toolbar__git-error'))).to.equal('git not found');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('offers to expand the editor over the agent column only while a tab is open, and says which way it goes', async () => {
    for (const [expandable, hiddenColumns, label] of /** @type {const} */ ([
      [false, [], null],
      [true, [], 'Expand editor'],
      [true, ['agent'], 'Collapse editor'],
    ])) {
      // Arrange
      const el = await fixture(html`<acp-toolbar .expandable=${expandable} .hiddenColumns=${[...hiddenColumns]}></acp-toolbar>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const button = /** @type {HTMLElement | null} */ (root.querySelector('#acp-toolbar-toggle-agent'));
      if (label === null) {
        expect(button, 'no tab, nothing to expand').to.equal(null);
        continue;
      }
      /** @type {unknown[]} */
      const toggled = [];
      el.addEventListener('acp-column-toggle', (/** @type {Event} */ e) => toggled.push(/** @type {CustomEvent} */ (e).detail));

      // Act
      /** @type {HTMLElement} */ (button).click();

      // Assert
      expect(tooltipOf(button), label).to.equal(label);
      expect(/** @type {HTMLElement} */ (button).getAttribute('aria-label')).to.equal(label);
      expect(toggled).to.deep.equal([{ column: 'agent' }]);
    }
  });
});
