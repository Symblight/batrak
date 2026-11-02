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
  upstreamSha: null,
  remote: { name: 'origin', url: 'https://example.test/a/b.git', github: null },
  hasRemotes: true,
  fetchedAt: null,
};

/** @param {() => unknown} ready */
async function until(ready) {
  const started = Date.now();
  while (!ready()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(3000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('acp-remote-chip', () => {
  it('shows what the branch needs next, describes it to a screen reader instead of a tooltip, and shows nothing without a branch to sync', async () => {
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
      expect(chip?.getAttribute('aria-description') ?? null, why).to.equal(tooltip);
      expect(tooltipOf(chip), 'results are told in snackbars, not a tooltip').to.equal(null);
      expect(root.querySelector('[title], md-tooltip'), why).to.equal(null);
    }
  });

  it('is a button that asks for the obvious operation only where one exists', async () => {
    /** @type {[string, GitRepoState, string | null][]} */
    const cases = [
      ['in sync', REPO, 'fetch'],
      ['ahead', { ...REPO, ahead: 1 }, 'push'],
      ['behind', { ...REPO, behind: 1 }, 'pull'],
      ['no upstream', { ...REPO, upstream: null }, 'publish'],
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

  it('offers a diverged branch its ways out: pull by rebase or merge, or replace the remote after a confirmation', async () => {
    // Arrange
    const repo = { ...REPO, ahead: 4, behind: 2, upstreamSha: 'f00d' };
    const el = await fixture(html`<acp-remote-chip .repo=${repo}></acp-remote-chip>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-git-remote', (/** @type {Event} */ e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    const open = async () => {
      /** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__chip')).click();
      await el.updateComplete;
      return [.../** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__popover')).querySelectorAll('md-button')];
    };
    // Act
    let items = await open();
    // Assert
    expect(items.map((i) => i.textContent?.trim())).to.deep.equal(['Pull with rebase', 'Pull with merge', 'Force push…']);
    expect(asked, 'opening the menu asks for nothing').to.deep.equal([]);

    // Act
    /** @type {HTMLElement} */ (items[0]).click();
    items = await open();
    /** @type {HTMLElement} */ (items[1]).click();
    // Assert
    expect(asked).to.deep.equal([{ action: 'pullRebase' }, { action: 'pullMerge' }]);

    // Act: the force push waits for the answer
    items = await open();
    /** @type {HTMLElement} */ (items[2]).click();
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (root.querySelector('acp-confirm-dialog'));
    await until(() => dialog.shadowRoot?.querySelector('.acp-confirm-dialog__action_destructive'));
    // Assert
    expect(asked, 'not before the answer').to.have.length(2);
    expect(dialog.shadowRoot?.textContent).to.contain('4 commits').and.to.contain('2 commits only on origin/main will be lost');
    // Act
    /** @type {HTMLElement} */ (dialog.shadowRoot?.querySelector('.acp-confirm-dialog__action_destructive')).click();
    await until(() => asked.length === 3);
    // Assert
    expect(asked[2], 'with the commit the user saw').to.deep.equal({ action: 'forcePush', expected: 'f00d' });
  });

  it('offers a pull that stopped on a conflict to abort or to look at the changes, not to retry', async () => {
    // Arrange
    const error = { kind: /** @type {const} */ ('conflict'), message: 'CONFLICT (content): Merge conflict in a.txt' };
    const el = await fixture(html`<acp-remote-chip
      .repo=${REPO}
      .op=${{ rootId: 'r', action: 'pullRebase', state: 'failed', error }}
    ></acp-remote-chip>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-git-remote', (/** @type {Event} */ e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    // Act
    /** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__chip')).click();
    await el.updateComplete;
    const buttons = [.../** @type {HTMLElement} */ (root.querySelector('.acp-remote-chip__popover')).querySelectorAll('md-button')];
    for (const button of buttons) /** @type {HTMLElement} */ (button).click();
    // Assert
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Show Changes', 'Abort', 'Dismiss']);
    expect(asked).to.deep.equal([{ action: 'showChanges' }, { action: 'abort' }, { action: 'dismiss' }]);
  });
});
