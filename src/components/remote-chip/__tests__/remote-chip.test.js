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

  it('is a button that asks for the obvious operation only where one exists', async () => {
    /** @type {[string, GitRepoState, string | null][]} */
    const cases = [
      ['in sync', REPO, 'fetch'],
      ['ahead', { ...REPO, ahead: 1 }, 'push'],
      ['behind', { ...REPO, behind: 1 }, 'pull'],
      ['no upstream', { ...REPO, upstream: null }, 'publish'],
      ['diverged', { ...REPO, ahead: 1, behind: 1 }, null],
      ['no remote', { ...REPO, upstream: null, remote: null, hasRemotes: false }, null],
    ];
    for (const [why, repo, action] of cases) {
      // Arrange
      const el = await fixture(html`<acp-remote-chip .repo=${repo}></acp-remote-chip>`);
      /** @type {unknown[]} */
      const asked = [];
      el.addEventListener('acp-git-remote', (/** @type {Event} */ e) => asked.push(/** @type {CustomEvent} */ (e).detail));
      const chip = /** @type {HTMLElement} */ ((/** @type {ShadowRoot} */ (el.shadowRoot)).querySelector('.acp-remote-chip__chip'));
      // Act
      chip.click();
      // Assert
      expect(asked, why).to.deep.equal(action ? [{ action }] : []);
      expect(chip.matches('button'), why).to.equal(action !== null);
    }
  });

  it('shows a running operation as busy, and a failed one in a popover with what can be done about it', async () => {
    // Arrange
    const error = { kind: /** @type {const} */ ('rejected'), message: '! [rejected] main -> main (fetch first)\nerror: failed to push' };
    const el = await fixture(html`<acp-remote-chip
      .repo=${{ ...REPO, ahead: 1 }}
      .op=${{ rootId: 'r', action: 'push', state: 'running', error: null }}
    ></acp-remote-chip>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const chip = () => /** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__chip'));
    // Assert
    expect([chip().textContent?.trim(), chip().matches('button')], 'busy, not clickable').to.deep.equal(['Pushing…', false]);

    // Act
    el.op = { rootId: 'r', action: 'push', state: 'failed', error };
    await el.updateComplete;
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-git-remote', (/** @type {Event} */ e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    chip().click();
    await el.updateComplete;
    const popover = /** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__popover'));
    const buttons = [...popover.querySelectorAll('md-button')];
    // Assert
    expect(chip().textContent?.trim()).to.equal('Push failed');
    expect(popover.matches(':popover-open'), 'the chip opens it').to.equal(true);
    expect(popover.textContent).to.contain('error: failed to push');
    expect(buttons.map((b) => b.textContent?.trim()), 'a rejected push can retry or pull').to.deep.equal(['Retry', 'Pull', 'Dismiss']);

    // Act
    for (const button of buttons) /** @type {HTMLElement} */ (button).click();
    // Assert
    expect(asked).to.deep.equal([{ action: 'push' }, { action: 'pull' }, { action: 'dismiss' }]);
  });
});
