import { expect, fixture, html } from '../../../../test/fixture.js';
import '../workspace-menu.js';

/** @typedef {import('../workspace-menu.js').AcpWorkspaceMenu} AcpWorkspaceMenu */
/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

const TASK = /** @type {Workspace} */ ({ id: 'w1', name: 'Fix login', folder: '/data/wt/fix-login/app', branch: 'brama/fix-login' });

/**
 * @param {Partial<AcpWorkspaceMenu>} props
 * @returns {Promise<AcpWorkspaceMenu>}
 */
async function render(props) {
  const el = /** @type {AcpWorkspaceMenu} */ (await fixture(html`<acp-workspace-menu></acp-workspace-menu>`));
  Object.assign(el, { mainFolder: '/work/app', ...props });
  await el.updateComplete;
  return el;
}

/** @param {AcpWorkspaceMenu} el */
const values = (el) => [...(el.shadowRoot?.querySelectorAll('md-menu-item') ?? [])].map((i) => i.getAttribute('value'));

/**
 * Picks an item as md-menu reports it.
 * @param {AcpWorkspaceMenu} el
 * @param {string} value
 */
function pick(el, value) {
  const menu = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('md-menu'));
  const item = el.shadowRoot?.querySelector(`md-menu-item[value="${value}"]`);
  menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
}

describe('acp-workspace-menu', () => {
  it("offers Main only Open in, Copy path and Reveal; a workspace also its own actions", async () => {
    // Arrange + Act
    const main = await render({ workspace: null });
    const task = await render({ workspace: TASK });

    // Assert
    expect(values(main)).to.deep.equal(['open-in', 'open-terminal', 'copy-path', 'reveal']);
    expect(values(task)).to.deep.equal(['rename', 'open-in', 'open-terminal', 'copy-path', 'reveal', 'changes', 'apply', 'check-out', 'delete']);
  });

  it('fires each pick as its own event, about its folder or workspace', async () => {
    /** @type {[Workspace | null, string, string, unknown][]} */
    const cases = [
      [TASK, 'rename', 'acp-workspace-rename-start', { id: 'w1' }],
      [TASK, 'open-terminal', 'acp-open-terminal', { path: '/data/wt/fix-login/app' }],
      [null, 'open-terminal', 'acp-open-terminal', { path: '/work/app' }],
      [TASK, 'copy-path', 'acp-copy', { text: '/data/wt/fix-login/app' }],
      [null, 'reveal', 'acp-reveal-path', { path: '/work/app' }],
      [TASK, 'changes', 'acp-workspace-changes', { id: 'w1' }],
      [TASK, 'apply', 'acp-workspace-apply', { id: 'w1' }],
      [TASK, 'check-out', 'acp-workspace-check-out', { id: 'w1' }],
      [TASK, 'delete', 'acp-workspace-delete-request', { id: 'w1' }],
    ];
    for (const [workspace, value, type, detail] of cases) {
      // Arrange
      const el = await render({ workspace });
      /** @type {CustomEvent[]} */
      const fired = [];
      document.addEventListener(type, (e) => fired.push(/** @type {CustomEvent} */ (e)), { once: true });

      // Act
      pick(el, value);

      // Assert
      expect(fired.map((e) => e.detail), value).to.deep.equal([detail]);
    }
  });

  it("names Reveal after the platform's file manager", async () => {
    for (const [platform, label] of [['mac', 'Show in Finder'], ['windows', 'Show in Explorer'], ['linux', 'Show in File Manager']]) {
      // Arrange + Act
      const el = await render({ workspace: TASK, platform: /** @type {import('../../../hooks/app/types.js').Platform} */ (platform) });

      // Assert
      expect(el.shadowRoot?.querySelector('md-menu-item[value="reveal"]')?.textContent?.trim(), platform).to.equal(label);
    }
  });
});
