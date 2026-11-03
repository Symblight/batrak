import { expect, fixture, html } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import '../workspace-dialog.js';

/** @typedef {import('../workspace-dialog.js').AcpWorkspaceDialog} AcpWorkspaceDialog */
/** @typedef {import('../../../hooks/git/types.js').BranchList} BranchList */

const PROJECTS = [
  { id: '/work/app', name: 'app' },
  { id: '/work/test', name: 'Test' },
];
/** @type {BranchList} */
const BRANCHES = { local: ['main', 'feature/x'], remotes: [{ remote: 'origin', branches: ['origin/main', 'origin/dev'] }], default: 'origin/main' };

/**
 * The dialog open on project `app`, recording what it fires.
 * @returns {Promise<{ el: AcpWorkspaceDialog, root: ShadowRoot, fired: { type: string, detail: unknown }[] }>}
 */
async function shown() {
  const el = /** @type {AcpWorkspaceDialog} */ (await fixture(html`<acp-workspace-dialog></acp-workspace-dialog>`));
  Object.assign(el, { projects: PROJECTS, projectPath: '/work/app', branches: BRANCHES, mainBranch: 'main' });
  /** @type {{ type: string, detail: unknown }[]} */
  const fired = [];
  for (const type of ['acp-workspace-create', 'acp-branches-query', 'acp-project-select']) {
    el.addEventListener(type, (e) => fired.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
  }
  await el.show();
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot), fired };
}

/** @param {ShadowRoot} root */
const isOpen = (root) => /** @type {HTMLElementTagNameMap['md-dialog']} */ (root.querySelector('md-dialog')).open;

/** @param {{ type: string, detail: unknown }[]} fired */
const created = (fired) => fired.filter((f) => f.type === 'acp-workspace-create').map((f) => f.detail);

/** @param {ShadowRoot} root */
const text = (root, /** @type {string} */ selector) => root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

/**
 * @param {AcpWorkspaceDialog} el
 * @param {string} value
 */
async function typePrompt(el, value) {
  const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (el.shadowRoot?.querySelector('.acp-workspace-dialog__prompt'));
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  await el.updateComplete;
}

/**
 * Picks `value` in the menu labelled `label`, as md-menu reports it.
 * @param {ShadowRoot} root
 * @param {string} label
 * @param {string} value
 */
function pick(root, label, value) {
  root.querySelector(`md-menu[aria-label="${label}"]`)?.dispatchEvent(new CustomEvent('select', { detail: { value } }));
}

describe('acp-workspace-dialog', () => {
  it('opens on an isolated workspace of the shown project, from the remote default; Create works with nothing typed', async () => {
    // Arrange
    const { root, fired } = await shown();
    const picker = root.querySelector('acp-branch-picker');

    // Act
    /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__create')).click();

    // Assert
    expect(text(root, '.acp-workspace-dialog__headline')).to.equal('Create workspace');
    expect(text(root, '.acp-workspace-dialog__subtitle')).to.equal('A separate checkout on its own new branch. Files, chats, changes, and terminals stay scoped to it.');
    expect([text(root, '.acp-workspace-dialog__project'), picker?.value]).to.deep.equal(['app', 'origin/main']);
    expect(root.querySelector('.acp-workspace-dialog__prompt')?.shadowRoot?.querySelector('textarea'), 'the text takes several lines').to.not.equal(null);
    expect(fired.filter((f) => f.type === 'acp-branches-query').map((f) => f.detail), 'asks for the branches as it opens').to.deep.equal([{}]);
    expect(created(fired)).to.deep.equal([{ mode: 'isolated', baseBranch: 'origin/main', prompt: null }]);
    expect(isOpen(root), 'closes').to.equal(false);
  });

  it('sends what was typed, picked from the branch picker, on Create or Mod+Enter, not Enter alone', async () => {
    const mac = app.platform === 'mac';
    for (const how of ['click', 'Mod+Enter']) {
      // Arrange
      const { el, root, fired } = await shown();
      await typePrompt(el, '  Fix the login form\n');
      root.querySelector('acp-branch-picker')?.dispatchEvent(new CustomEvent('acp-branch-pick', { detail: { branch: 'feature/x' }, bubbles: true, composed: true }));
      const field = /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__prompt'));
      /** @param {KeyboardEventInit} init */
      const enter = (init) => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true, ...init }));
      enter({});
      const onPlainEnter = created(fired).length;

      // Act
      if (how === 'click') /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__create')).click();
      else enter({ metaKey: mac, ctrlKey: !mac });

      // Assert
      expect(onPlainEnter, `${how}: Enter alone is a new line`).to.equal(0);
      expect(created(fired), how).to.deep.equal([{ mode: 'isolated', baseBranch: 'feature/x', prompt: 'Fix the login form' }]);
    }
  });

  it('runs in the project folder: says so, picks no branch, and creates a chat there', async () => {
    // Arrange
    const { el, root, fired } = await shown();

    // Act
    const segments = /** @type {HTMLElement} */ (root.querySelector('md-segmented-button-group'));
    segments.dispatchEvent(new CustomEvent('change', { detail: { value: 'project' }, bubbles: true }));
    await el.updateComplete;
    /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__create')).click();

    // Assert
    expect(text(root, '.acp-workspace-dialog__subtitle')).to.equal('Runs directly in your project folder — no isolation. Changes land on the current branch.');
    expect(root.querySelector('acp-branch-picker'), 'no branch').to.equal(null);
    expect(created(fired)).to.deep.equal([{ mode: 'project', baseBranch: null, prompt: null }]);
  });

  it('asks to show a project picked in its menu, then lists that project’s branches from its default', async () => {
    // Arrange
    const { el, root, fired } = await shown();

    // Act: picked, then shown by the container with its own branches
    pick(root, 'Projects', '/work/test');
    Object.assign(el, { projectPath: '/work/test', branches: { local: ['trunk'], remotes: [], default: null }, mainBranch: 'trunk' });
    await el.updateComplete;

    // Assert
    expect(fired.filter((f) => f.type !== 'acp-workspace-create').map((f) => f.type)).to.deep.equal(['acp-branches-query', 'acp-project-select', 'acp-branches-query']);
    expect(fired.find((f) => f.type === 'acp-project-select')?.detail).to.deep.equal({ projectId: '/work/test' });
    expect([text(root, '.acp-workspace-dialog__project'), root.querySelector('acp-branch-picker')?.value]).to.deep.equal(['Test', 'trunk']);
  });
  it('fetches the branches once per opening, the first time its branch menu loads, and again for another project', async () => {
    // Arrange
    const { el, root } = await shown();
    let fetches = 0;
    el.fetchBranches = async () => void fetches++;
    const load = () => /** @type {HTMLElementTagNameMap['acp-branch-picker']} */ (root.querySelector('acp-branch-picker')).load?.();

    // Act
    await load();
    await load();
    const once = fetches;
    el.projectPath = '/work/test';
    await el.updateComplete;
    await load();
    const anotherProject = fetches;
    await el.show();
    await load();

    // Assert
    expect([once, anotherProject, fetches]).to.deep.equal([1, 2, 3]);
  });
  it('follows the branches as they arrive for its default, until a branch is picked', async () => {
    // Arrange: opened before this project's branches came (the container still had another's)
    const { el, root } = await shown();
    const picker = () => /** @type {HTMLElementTagNameMap['acp-branch-picker']} */ (root.querySelector('acp-branch-picker'));

    // Act
    el.branches = { local: ['trunk'], remotes: [{ remote: 'up', branches: ['up/trunk'] }], default: 'up/trunk' };
    await el.updateComplete;
    const arrived = picker().value;
    picker().dispatchEvent(new CustomEvent('acp-branch-pick', { detail: { branch: 'trunk' }, bubbles: true, composed: true }));
    el.branches = { ...el.branches };
    await el.updateComplete;

    // Assert
    expect([arrived, picker().value]).to.deep.equal(['up/trunk', 'trunk']);
  });
});
