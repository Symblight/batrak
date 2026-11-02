import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../branch-popover.js';

/** @typedef {import('../../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../../hooks/git/types.js').GitBranchList} GitBranchList */

/** @type {GitRepoState} */
const REPO = {
  branch: 'main',
  sha: 'abc1234def',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  upstreamSha: null,
  remote: { name: 'origin', url: 'https://example.test/a/b.git', github: null },
  hasRemotes: true,
  fetchedAt: null,
};

const NOW = Date.now();
/** @type {GitBranchList} */
const BRANCHES = {
  local: [
    { name: 'main', current: true, ahead: 2, behind: 0, committedAt: NOW },
    { name: 'feature/x', current: false, ahead: 0, behind: 0, committedAt: NOW - 2 * 3_600_000 },
    { name: 'brama/session-1', current: false, ahead: 0, behind: 0, committedAt: NOW - 24 * 3_600_000 },
  ],
  remote: [{ remote: 'origin', name: 'feature/y' }],
};

/**
 * @param {Partial<{ repo: GitRepoState | null, branches: GitBranchList | null }>} [props]
 * @returns {Promise<{ el: any, root: ShadowRoot, events: { type: string, detail: unknown }[] }>}
 */
async function shown(props = {}) {
  const { repo = REPO, branches = BRANCHES } = props;
  const el = await fixture(html`<acp-branch-popover .repo=${repo} .branches=${branches}></acp-branch-popover>`);
  /** @type {{ type: string, detail: unknown }[]} */
  const events = [];
  for (const type of ['acp-git-branches-query', 'acp-git-switch', 'acp-git-remote', 'acp-copy']) {
    el.addEventListener(type, (/** @type {Event} */ e) => events.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
  }
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot), events };
}

/** @param {ShadowRoot} root @param {string} selector */
const q = (root, selector) => /** @type {HTMLElement} */ (root.querySelector(selector));
/** @param {ShadowRoot} root @param {string} selector */
const all = (root, selector) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);
/** @param {ShadowRoot} root */
const rows = (root) => all(root, '.acp-branch-popover__row').map((r) => r.textContent?.replace(/\s+/g, ' ').trim());

/** @param {any} el @param {ShadowRoot} root */
async function open(el, root) {
  q(root, '.acp-branch-popover__trigger').click();
  await el.updateComplete;
}

describe('acp-branch-popover', () => {
  it('names the branch on a button that opens the popover and asks for the branches; nothing outside a repository', async () => {
    /** @type {[string, GitRepoState | null, string | null][]} */
    const cases = [
      ['a branch', REPO, 'main'],
      ['a detached HEAD', { ...REPO, branch: null, detached: true }, 'abc1234'],
      ['outside a repository', null, null],
    ];
    for (const [why, repo, label] of cases) {
      // Arrange + Act
      const { root } = await shown({ repo });
      const trigger = root.querySelector('.acp-branch-popover__trigger');
      // Assert
      expect(trigger?.textContent?.trim() ?? null, why).to.equal(label);
      expect(root.querySelector('[title]'), why).to.equal(null);
    }

    // Arrange
    const { el, root, events } = await shown();
    const trigger = q(root, '.acp-branch-popover__trigger');
    expect(trigger.getAttribute('aria-haspopup')).to.equal('dialog');
    expect(trigger.getAttribute('aria-expanded')).to.equal('false');
    expect(tooltipOf(trigger)).to.equal('Branch main, tracking origin/main');
    // Act
    await open(el, root);
    // Assert
    expect(q(root, '.acp-branch-popover__popover').matches(':popover-open')).to.equal(true);
    expect(trigger.getAttribute('aria-expanded')).to.equal('true');
    expect(events).to.deep.equal([{ type: 'acp-git-branches-query', detail: null }]);
  });

  it('lists the local branches with the current one marked, then the remote ones, and filters them as you type', async () => {
    // Arrange
    const { el, root } = await shown();
    // Act
    await open(el, root);
    // Assert
    expect(rows(root)).to.deep.equal(['main ↑2 · now', 'feature/x 2h', 'brama/session-1 session · 1d', 'feature/y origin']);
    expect(q(root, '.acp-branch-popover__row_current').textContent).to.contain('main');

    // Act
    const filter = /** @type {HTMLInputElement} */ (q(root, '.acp-branch-popover__filter'));
    filter.value = 'FEATURE';
    filter.dispatchEvent(new Event('input'));
    await el.updateComplete;
    // Assert
    expect(rows(root)).to.deep.equal(['feature/x 2h', 'feature/y origin']);
  });

  it('switches to the branch picked — a remote one by its short name — and does nothing for the current one', async () => {
    // Arrange
    const { el, root, events } = await shown();
    await open(el, root);
    const row = (/** @type {string} */ name) => all(root, '.acp-branch-popover__row').find((r) => r.textContent?.includes(name));
    // Act
    row('main')?.click();
    row('feature/x')?.click();
    row('feature/y')?.click();
    // Assert
    expect(events.filter((e) => e.type === 'acp-git-switch').map((e) => e.detail)).to.deep.equal([
      { branch: 'feature/x', create: false },
      { branch: 'feature/y', create: false },
    ]);
  });

  it('makes a new branch from the name typed, and ignores an empty one', async () => {
    // Arrange
    const { el, root, events } = await shown();
    await open(el, root);
    // Act
    q(root, '.acp-branch-popover__new').click();
    await el.updateComplete;
    const name = /** @type {HTMLInputElement} */ (q(root, '.acp-branch-popover__name'));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    name.value = ' fix/y ';
    name.dispatchEvent(new Event('input'));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Assert
    expect(events.filter((e) => e.type === 'acp-git-switch').map((e) => e.detail)).to.deep.equal([{ branch: 'fix/y', create: true }]);
  });

  it('shows what git refused and stays open, and closes once the switch worked', async () => {
    // Arrange
    const { el, root } = await shown();
    await open(el, root);
    const popover = q(root, '.acp-branch-popover__popover');
    // Act
    el.switchFinished('Your local changes to README.md would be overwritten');
    await el.updateComplete;
    // Assert
    expect(q(root, '.acp-branch-popover__error').textContent).to.contain('README.md');
    expect(popover.matches(':popover-open')).to.equal(true);
    // Act
    el.switchFinished(null);
    await el.updateComplete;
    // Assert
    expect(popover.matches(':popover-open')).to.equal(false);
    expect(root.querySelector('.acp-branch-popover__error')).to.equal(null);
  });

  it('offers the branch name to copy, what to do about the remote, and Fetch', async () => {
    /** @type {[string, Partial<GitRepoState>, string | null, string, boolean][]} */
    const cases = [
      ['ahead', { ahead: 4 }, 'push', '4 commits to push to origin/main · not fetched yet', true],
      ['behind', { behind: 2 }, 'pull', '2 commits to pull from origin/main · not fetched yet', true],
      ['not published', { upstream: null }, 'publish', 'Branch main is not on origin yet', true],
      ['in sync', {}, null, 'Up to date with origin/main · not fetched yet', true],
      ['no remote', { upstream: null, remote: null, hasRemotes: false }, null, 'Add a remote in a terminal: git remote add origin <url>', false],
    ];
    for (const [why, fields, primary, fact, canFetch] of cases) {
      // Arrange
      const { el, root, events } = await shown({ repo: { ...REPO, ...fields } });
      await open(el, root);
      // Act
      q(root, '.acp-branch-popover__copy').click();
      root.querySelector('.acp-branch-popover__primary')?.dispatchEvent(new MouseEvent('click'));
      root.querySelector('.acp-branch-popover__fetch')?.dispatchEvent(new MouseEvent('click'));
      // Assert
      expect(q(root, '.acp-branch-popover__remote').textContent?.trim(), why).to.equal(fact);
      expect(events.filter((e) => e.type === 'acp-copy').map((e) => e.detail), why).to.deep.equal([{ text: 'main' }]);
      const asked = events.filter((e) => e.type === 'acp-git-remote').map((e) => /** @type {{ action: string }} */ (e.detail).action);
      expect(asked, why).to.deep.equal([...(primary ? [primary] : []), ...(canFetch ? ['fetch'] : [])]);
    }
  });
});
