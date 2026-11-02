import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../remote-chip.js';

/** @typedef {import('../../../hooks/git/types.js').GitRepoState} GitRepoState */

/** @type {GitRepoState} */
const REPO = {
  branch: 'main',
  sha: 'abc1234',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  remote: { name: 'origin', url: 'https://example.test/a/b.git', github: null },
  hasRemotes: true,
  fetchedAt: null,
};

describe('acp-remote-chip', () => {
  it('shows what the branch needs next with its tooltip, and nothing without a branch to sync', async () => {
    /** @type {[string, GitRepoState | null, string | null, string | null][]} */
    const cases = [
      ['in sync', REPO, 'Synced', 'Up to date with origin/main · not fetched yet'],
      ['ahead', { ...REPO, ahead: 4 }, 'Push 4', '4 commits to push to origin/main · not fetched yet'],
      ['behind', { ...REPO, behind: 2 }, 'Pull 2', '2 commits to pull from origin/main · not fetched yet'],
      ['diverged', { ...REPO, ahead: 4, behind: 2 }, '↑4 | ↓2', 'Diverged from origin/main: 4 to push, 2 to pull · not fetched yet'],
      ['no upstream', { ...REPO, upstream: null }, 'Publish', 'Branch main is not on origin yet'],
      ['no remote', { ...REPO, upstream: null, remote: null, hasRemotes: false }, 'No remote', 'Add a remote in a terminal: git remote add origin <url>'],
      ['detached', { ...REPO, branch: null, detached: true, upstream: null }, null, null],
      ['outside a repository', null, null, null],
    ];
    for (const [why, repo, label, tooltip] of cases) {
      // Arrange + Act
      const el = await fixture(html`<acp-remote-chip .repo=${repo}></acp-remote-chip>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const chip = root.querySelector('.acp-remote-chip__chip');
      // Assert
      expect(chip?.textContent?.trim() ?? null, why).to.equal(label);
      expect(tooltipOf(chip), why).to.equal(tooltip);
      expect(root.querySelector('[title]'), why).to.equal(null);
    }
  });
});
