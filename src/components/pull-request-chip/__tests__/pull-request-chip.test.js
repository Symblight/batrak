import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../pull-request-chip.js';

describe('acp-pull-request-chip', () => {
  it('offers the way in while GitHub is not usable, asks to sign in on click, and shows nothing otherwise', async () => {
    /** @type {[string, string | null][]} */
    const cases = [
      ['signedOut', 'Sign in to GitHub'],
      ['noCli', 'Install GitHub CLI'],
      ['ok', null],
      ['loading', null],
      ['hidden', null],
    ];
    for (const [status, label] of cases) {
      // Arrange
      const el = await fixture(html`<acp-pull-request-chip .status=${status}></acp-pull-request-chip>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const button = /** @type {HTMLElement | null} */ (root.querySelector('.acp-pull-request-chip__button'));
      /** @type {unknown[]} */
      const asked = [];
      el.addEventListener('acp-github-sign-in', () => asked.push(true));
      // Act
      button?.click();
      // Assert
      expect(button?.textContent?.trim() ?? null, status).to.equal(label);
      expect(asked.length, status).to.equal(label ? 1 : 0);
      if (button) expect(tooltipOf(button), status).to.be.a('string').and.not.equal('');
    }
  });

  it('shows the branch\'s pull request, or Create PR where one can be made, and opens the right page', async () => {
    const repo = /** @type {import('../../../hooks/git/types.js').GitRepoState} */ ({
      branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: null, hasRemotes: true, fetchedAt: null,
      remote: { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } },
    });
    const pr = (/** @type {object} */ fields = {}) => ({ number: 128, title: 'T', url: 'https://github.com/a/b/pull/128', state: 'OPEN', isDraft: false, reviewDecision: null, checks: 'SUCCESS', ...fields });
    const reply = (/** @type {object | null} */ found, defaultBranch = 'main') => ({ status: 'ok', pr: found, defaultBranch, message: null });
    /** @type {[string, string, object | null, object, string | null, string | null][]} why, status, reply, repo, label, opens */
    const cases = [
      ['open', 'ok', reply(pr()), repo, '#128 Open', 'https://github.com/a/b/pull/128'],
      ['draft', 'ok', reply(pr({ isDraft: true, checks: 'PENDING' })), repo, '#128 Draft', 'https://github.com/a/b/pull/128'],
      ['merged', 'ok', reply(pr({ state: 'MERGED' })), repo, '#128 Merged', 'https://github.com/a/b/pull/128'],
      ['none yet', 'ok', reply(null), repo, 'Create PR', 'https://github.com/a/b/compare/main...feat?expand=1'],
      ['none, not published', 'ok', reply(null), { ...repo, upstream: null }, 'Create PR', null],
      ['looked up with no answer', 'ok', null, repo, null, null],
      ['no access', 'noAccess', reply(null), repo, 'No access', null],
    ];
    for (const [why, status, found, state, label, opens] of cases) {
      // Arrange
      const el = await fixture(html`<acp-pull-request-chip .status=${status} .reply=${found} .repo=${state}></acp-pull-request-chip>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const chip = /** @type {HTMLButtonElement | null} */ (root.querySelector('.acp-pull-request-chip__button'));
      /** @type {unknown[]} */
      const asked = [];
      el.addEventListener('acp-github-open', (/** @type {Event} */ e) => asked.push(/** @type {CustomEvent} */ (e).detail));
      // Act
      chip?.click();
      // Assert
      expect(chip?.textContent?.trim() ?? null, why).to.equal(label);
      expect(asked, why).to.deep.equal(opens ? [{ url: opens }] : []);
      expect(chip?.disabled ?? false, why).to.equal(label === 'Create PR' && !opens);
      if (chip) expect(tooltipOf(chip), why).to.be.a('string').and.not.equal('');
    }
  });
});
