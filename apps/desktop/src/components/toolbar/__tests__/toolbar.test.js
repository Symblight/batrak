import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../toolbar.js';

/** @typedef {import('../../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../../hooks/git/types.js').GitRepoState} GitRepoState */

/** @type {GitRepoState} */
const REPO = { branch: 'main', sha: 'abc1234def', detached: false, upstream: 'origin/main', ahead: 2, behind: 0, upstreamSha: null, remote: null };

/** @type {GitRepoView} */
const GIT = { repo: REPO, error: null };

/** @type {import('../../../hooks/github/types.js').GithubPrReply} */
const REPLY = { status: 'ok', pr: null, defaultBranch: 'main', message: null };

describe('acp-toolbar', () => {
  it('shows the project menu with the listed projects, and the GitHub slot as a component of its own, not titles', async () => {
    const projects = [{ id: '/work/app', name: 'app', path: '/work/app' }];
    const el = await fixture(html`<acp-toolbar
      .project=${{ path: '/work/app', name: 'app', rootId: 'r1' }}
      .projects=${projects}
      .unread=${{ '/work/app': 1 }}
      .home=${'/work'}
      .git=${GIT}
      .githubSlot=${'ok'}
      .githubReply=${REPLY}
    ></acp-toolbar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const menu = root.querySelector('acp-project-menu');
    expect([menu?.projects, menu?.currentId, menu?.unread, menu?.home], 'the project button is the menu\'s').to.deep.equal([
      projects,
      '/work/app',
      { '/work/app': 1 },
      '/work',
    ]);
    const slot = root.querySelector('acp-pull-request-chip');
    expect([slot?.status, slot?.reply, slot?.repo], 'GitHub slot').to.deep.equal(['ok', REPLY, GIT.repo]);
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('offers the project menu with no project open, and no git or workspaces beside it', async () => {
    const el = await fixture(html`<acp-toolbar></acp-toolbar>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('acp-project-menu')?.currentId).to.equal(null);
    expect(root.querySelector('acp-branch-popover')).to.equal(null);
    expect(root.querySelector('acp-workspace-picker')).to.equal(null);
  });

  it("hands the workspace picker the shown project's workspaces, their statuses and numbers, and the shown one", async () => {
    // Arrange
    const list = [/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', name: 'Fix login' })];
    const statuses = { w1: 'waiting', main: 'idle' };
    const numbers = { main: 1, w1: 2 };

    // Act
    const el = await fixture(html`<acp-toolbar
      .project=${{ path: '/work/app', name: 'app', rootId: 'r1' }}
      .workspaces=${list}
      .workspaceStatuses=${statuses}
      .workspaceNumbers=${numbers}
      .workspaceId=${'w1'}
      workspaces-enabled
    ></acp-toolbar>`);

    // Assert
    const picker = el.shadowRoot?.querySelector('acp-workspace-picker');
    expect([picker?.workspaces, picker?.statuses, picker?.numbers, picker?.currentId, picker?.projectName, picker?.projectPath, picker?.enabled]).to.deep.equal([
      list,
      statuses,
      numbers,
      'w1',
      'app',
      '/work/app',
      true,
    ]);
  });

  it('shows the branch in its card, with the pull request found for it', async () => {
    // Arrange
    /** @type {import('../../../hooks/github/types.js').GithubPrReply} */
    const found = { ...REPLY, pr: { number: 9, title: 'T', url: 'u', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null, failedChecks: [] } };
    // Act
    const el = await fixture(html`<acp-toolbar .project=${{ path: '/work/app', name: 'app', rootId: 'r1' }} .git=${GIT} .githubReply=${found}></acp-toolbar>`);
    // Assert
    const card = /** @type {ShadowRoot} */ (el.shadowRoot).querySelector('acp-branch-popover');
    expect([card?.repo, card?.pr]).to.deep.equal([REPO, found.pr]);
  });

  it('says why git is unavailable in a tooltip', async () => {
    const el = await fixture(html`<acp-toolbar
      .project=${{ path: '/work/app', name: 'app', rootId: 'r1' }}
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
