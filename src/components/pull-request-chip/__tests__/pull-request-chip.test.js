import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../pull-request-chip.js';

describe('acp-pull-request-chip', () => {
  it('tells how to sign in while GitHub is not signed in, and shows nothing without the CLI or a pull request lookup', async () => {
    /** @type {[string, string | null][]} */
    const cases = [
      ['signedOut', 'Not signed in'],
      ['noCli', null],
      ['ok', null],
      ['loading', null],
      ['hidden', null],
    ];
    for (const [status, label] of cases) {
      // Arrange + Act
      const el = await fixture(html`<acp-pull-request-chip .status=${status}></acp-pull-request-chip>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const chip = /** @type {HTMLElement | null} */ (root.querySelector('.acp-pull-request-chip__button'));
      // Assert
      expect(chip?.textContent?.trim() ?? null, status).to.equal(label);
      if (chip) {
        expect(chip.tagName, 'nothing to click: signing in happens in a terminal').to.not.equal('BUTTON');
        expect(tooltipOf(chip), status).to.include('gh auth login');
      }
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
      ['none yet', 'ok', reply(null), repo, 'Create PR', 'https://github.com/a/b/compare/main...a:feat?expand=1'],
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

  it('keeps showing the pull request while GitHub can\'t be reached, and says so', async () => {
    // Arrange
    const repo = { branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: null, hasRemotes: true, fetchedAt: null, remote: { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } } };
    const reply = { status: 'ok', pr: { number: 128, title: 'T', url: 'https://github.com/a/b/pull/128', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null }, defaultBranch: 'main', message: null, stale: 'error connecting to api.github.com' };
    // Act
    const el = await fixture(html`<acp-pull-request-chip .status=${'ok'} .reply=${reply} .repo=${repo}></acp-pull-request-chip>`);
    const chip = /** @type {ShadowRoot} */ (el.shadowRoot).querySelector('.acp-pull-request-chip__button');
    // Assert
    expect(chip?.textContent?.trim()).to.equal('#128 Open');
    expect(tooltipOf(chip)).to.equal("Couldn't reach GitHub: error connecting to api.github.com; retrying");
  });
});
