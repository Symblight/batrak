import { expect, fixture, html } from '../../../../test/fixture.js';
import { app } from '../../../hooks/app/app.js';
import '../workspace-dialog.js';

/** @typedef {import('../workspace-dialog.js').AcpWorkspaceDialog} AcpWorkspaceDialog */

const AGENTS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];

/** @returns {Promise<{ el: AcpWorkspaceDialog, root: ShadowRoot, created: unknown[] }>} */
async function shown() {
  const el = /** @type {AcpWorkspaceDialog} */ (await fixture(html`<acp-workspace-dialog></acp-workspace-dialog>`));
  Object.assign(el, {
    branches: ['main', 'feature/x', 'brama/fix-login'],
    currentBranch: 'feature/x',
    baseBranch: 'main',
    taken: ['brama/fix-login'],
    agents: AGENTS,
    agentId: 'codex',
  });
  /** @type {unknown[]} */
  const created = [];
  el.addEventListener('acp-workspace-create', (e) => created.push(/** @type {CustomEvent} */ (e).detail));
  await el.show();
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot), created };
}

/** @param {ShadowRoot} root */
const isOpen = (root) => /** @type {HTMLElementTagNameMap['md-dialog']} */ (root.querySelector('md-dialog')).open;

/** @param {ShadowRoot} root */
const createButton = (root) => /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__create'));

/**
 * @param {AcpWorkspaceDialog} el
 * @param {ShadowRoot} root
 * @param {string} value
 */
async function typeName(el, root, value) {
  const field = /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('md-text-field'));
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  await el.updateComplete;
}

describe('acp-workspace-dialog', () => {
  it('creates at once with nothing typed: no name, the base branch and the default agent', async () => {
    // Arrange
    const { root, created } = await shown();
    const [base, agent] = [...root.querySelectorAll('.acp-workspace-dialog__picker')].map((f) => /** @type {HTMLElementTagNameMap['md-text-field']} */ (f));
    const notes = [...root.querySelectorAll('.acp-workspace-dialog__note')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim());

    // Act
    createButton(root).click();

    // Assert
    expect([base.value, agent.value]).to.deep.equal(['main', 'Codex']);
    expect(notes).to.deep.equal(['Optional: the agent names it from your first message · branch brama/…', 'Project base branch', 'Project default']);
    expect([...root.querySelectorAll('md-menu[aria-label="Based on"] md-menu-item')].map((o) => o.getAttribute('value')), 'current branch first, then the base').to.deep.equal(['feature/x', 'main', 'brama/fix-login']);
    expect(created).to.deep.equal([{ name: null, baseBranch: 'main', agentId: 'codex' }]);
    expect(isOpen(root), 'closes').to.equal(false);
  });

  it('shows the branch a name gets under the field, numbered when taken', async () => {
    // Arrange
    const { el, root } = await shown();
    const hint = () => root.querySelector('.acp-workspace-dialog__branch')?.textContent?.trim() ?? null;
    const empty = hint();

    // Act
    await typeName(el, root, 'Fix login');

    // Assert
    expect(empty).to.equal(null);
    expect(hint()).to.equal('brama/fix-login-2');
  });

  it('creates on Mod+Enter, not Enter alone, with what was typed and picked', async () => {
    // Arrange
    const { el, root, created } = await shown();
    await typeName(el, root, '  Add search ');
    root.querySelector('md-menu[aria-label="Based on"]')?.dispatchEvent(new CustomEvent('select', { detail: { value: 'feature/x' } }));
    const mac = app.platform === 'mac';

    const field = /** @type {HTMLElement} */ (root.querySelector('.acp-workspace-dialog__name'));
    /** @param {KeyboardEventInit} init */
    const enter = (init) => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true, ...init }));

    // Act
    enter({});
    const onPlainEnter = created.length;
    enter({ metaKey: mac, ctrlKey: !mac });

    // Assert
    expect(onPlainEnter, 'Enter alone creates nothing').to.equal(0);
    expect(created).to.deep.equal([{ name: 'Add search', baseBranch: 'feature/x', agentId: 'codex' }]);
    expect(isOpen(root)).to.equal(false);
  });

  it('asks for the branches as it opens and cancels with nothing created', async () => {
    // Arrange
    const el = /** @type {AcpWorkspaceDialog} */ (await fixture(html`<acp-workspace-dialog></acp-workspace-dialog>`));
    /** @type {unknown[]} */
    const asked = [];
    el.addEventListener('acp-branches-query', (e) => asked.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {unknown[]} */
    const created = [];
    el.addEventListener('acp-workspace-create', (e) => created.push(e));

    // Act
    await el.show();
    /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-workspace-dialog__cancel')).click();
    await el.updateComplete;

    // Assert
    expect(asked).to.deep.equal([{}]);
    expect(created).to.deep.equal([]);
    expect(isOpen(/** @type {ShadowRoot} */ (el.shadowRoot))).to.equal(false);
  });
});
