import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../branch-popover.js';

/** @typedef {import('../../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../../hooks/github/types.js').GithubPullRequest} GithubPullRequest */

/** @type {GitRepoState} */
const REPO = {
  branch: 'spec/git-remote-sync',
  sha: 'abc1234def',
  detached: false,
  upstream: 'origin/spec/git-remote-sync',
  ahead: 0,
  behind: 0,
  upstreamSha: 'abc1234def',
  remote: { name: 'origin', url: 'git@github.com:a/b.git', github: { owner: 'a', repo: 'b' } },
};

/** @type {GithubPullRequest} */
const PR = { number: 9, title: 'T', url: 'https://github.com/a/b/pull/9', state: 'OPEN', isDraft: false, reviewDecision: null, checks: 'FAILURE', failedChecks: ['backend'] };

/**
 * The card for `repo` and `pr`, with the events it fired.
 * @param {GitRepoState | null} repo
 * @param {GithubPullRequest | null} [pr]
 */
async function shown(repo, pr = null) {
  const el = await fixture(html`<acp-branch-popover .repo=${repo} .pr=${pr}></acp-branch-popover>`);
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  /** @type {{ type: string, detail: unknown }[]} */
  const events = [];
  for (const type of ['acp-copy', 'acp-github-open']) el.addEventListener(type, (/** @type {Event} */ e) => events.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
  return { el, root, events };
}

/** The text of each row of the open card, by its label. @param {ShadowRoot} root */
const rows = (root) =>
  Object.fromEntries(
    [...root.querySelectorAll('.acp-branch-popover__label')].map((label) => [label.textContent?.trim(), label.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim()]),
  );

describe('acp-branch-popover', () => {
  it('names the branch, or the commit of a detached HEAD, on a button that opens the card; nothing outside a repository', async () => {
    /** @type {[string, GitRepoState | null, string | null][]} */
    const cases = [
      ['a branch', REPO, 'spec/git-remote-sync'],
      ['a detached HEAD', { ...REPO, branch: null, detached: true }, 'abc1234'],
      ['outside a repository', null, null],
    ];
    for (const [why, repo, label] of cases) {
      // Arrange
      const { el, root } = await shown(repo);
      const trigger = /** @type {HTMLElement | null} */ (root.querySelector('.acp-branch-popover__trigger'));
      // Act
      trigger?.click();
      await /** @type {import('lit').LitElement} */ (el).updateComplete;
      // Assert
      expect(trigger?.textContent?.trim() ?? null, why).to.equal(label);
      if (trigger) {
        expect(trigger.getAttribute('aria-expanded'), why).to.equal('true');
        expect(root.querySelector('.acp-branch-popover__popover')?.matches(':popover-open'), why).to.equal(true);
        expect(root.querySelector('[title]'), why).to.equal(null);
      }
    }
  });

  it('shows the branch, how it stands against its remote, its pull request and its checks', async () => {
    // Arrange
    const { root } = await shown({ ...REPO, ahead: 2 }, PR);
    // Act
    const shownRows = rows(root);
    // Assert
    expect(shownRows).to.deep.equal({
      Branch: 'spec/git-remote-sync',
      Remote: '2 commits to push to origin',
      'Pull request': 'PR #9 · Open',
      'Compare to': '',
      Checks: '1 check failing: backend',
    });
    const { root: withoutPr } = await shown(REPO);
    expect(rows(withoutPr), 'no pull request: no rows for it').to.deep.equal({ Branch: 'spec/git-remote-sync', Remote: 'In sync with origin', 'Compare to': '' });
  });

  it('copies the branch name and opens the pull request', async () => {
    // Arrange
    const { root, events } = await shown(REPO, PR);
    const copy = /** @type {HTMLElement} */ (root.querySelector('.acp-branch-popover__copy'));
    const openPr = /** @type {HTMLElement} */ (root.querySelector('.acp-branch-popover__open'));
    // Act
    copy.click();
    openPr.click();
    // Assert
    expect(events).to.deep.equal([
      { type: 'acp-copy', detail: { text: 'spec/git-remote-sync' } },
      { type: 'acp-github-open', detail: { url: PR.url } },
    ]);
    expect([tooltipOf(copy), tooltipOf(openPr)]).to.deep.equal(['Copy branch name', 'Open on GitHub']);
  });

  describe('Compare to', () => {
    const BRANCHES = { local: ['dev'], remotes: [], default: null };

    /** @param {Partial<HTMLElementTagNameMap['acp-branch-popover']>} [props] */
    async function comparing(props = {}) {
      const { el, root } = await shown(REPO);
      const card = /** @type {import('../branch-popover.js').AcpBranchPopover} */ (/** @type {unknown} */ (el));
      Object.assign(card, { branches: BRANCHES, ...props });
      await card.updateComplete;
      const picker = /** @type {HTMLElementTagNameMap['acp-branch-picker']} */ (root.querySelector('acp-branch-picker'));
      const popover = /** @type {HTMLElement} */ (root.querySelector('.acp-branch-popover__popover'));
      return { card, root, picker, popover };
    }

    it('lists the branches, names the current one’s local work while nothing is compared, and the branch once one is', async () => {
      // Arrange
      /** @type {() => Promise<void>} */
      const loadBranches = async () => {};
      const { card, root, picker } = await comparing({ loadBranches });
      const before = rows(root)['Compare to'];
      // Act
      card.compareTo = 'origin/main';
      await card.updateComplete;
      await picker.updateComplete;
      // Assert
      expect(before).to.not.equal(undefined);
      expect(picker.offLabel).to.equal('spec/git-remote-sync - local');
      expect(picker.list).to.equal(BRANCHES);
      expect(picker.load).to.equal(loadBranches);
      expect(picker.value).to.equal('origin/main');
    });

    it('a pick asks for that comparison and closes the card; the local choice asks for none', async () => {
      // Arrange
      const { card, picker, popover } = await comparing();
      /** @type {unknown[]} */
      const asked = [];
      card.addEventListener('acp-compare-pick', (e) => asked.push(/** @type {CustomEvent} */ (e).detail));
      /** @type {unknown[]} */
      const leaked = [];
      card.addEventListener('acp-branch-pick', (e) => leaked.push(e));
      popover.showPopover();
      // Act
      picker.dispatchEvent(new CustomEvent('acp-branch-pick', { detail: { branch: 'dev' }, bubbles: true, composed: true }));
      const open = popover.matches(':popover-open');
      picker.dispatchEvent(new CustomEvent('acp-branch-pick', { detail: { branch: null }, bubbles: true, composed: true }));
      // Assert
      expect(asked).to.deep.equal([{ branch: 'dev' }, { branch: null }]);
      expect(open).to.equal(false);
      expect(leaked).to.deep.equal([]);
    });

    it('closing the card closes the menu, which Esc would leave marked open', async () => {
      // Arrange
      const { picker, popover } = await comparing();
      popover.showPopover();
      const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (/** @type {ShadowRoot} */ (picker.shadowRoot).querySelector('md-menu'));
      await menu.show();
      // Act
      popover.hidePopover();
      // Assert
      expect(menu.open).to.equal(false);
    });

    it('names the commit of a detached HEAD for its local work', async () => {
      // Arrange + Act
      const { root } = await shown({ ...REPO, branch: null, detached: true });
      // Assert
      expect(/** @type {HTMLElementTagNameMap['acp-branch-picker']} */ (root.querySelector('acp-branch-picker')).offLabel).to.equal('abc1234 - local');
    });

    it('isn’t offered before the first commit', async () => {
      // Arrange + Act
      const { root } = await shown({ ...REPO, sha: null });
      // Assert
      expect(root.querySelector('acp-branch-picker')).to.equal(null);
    });
  });
});
