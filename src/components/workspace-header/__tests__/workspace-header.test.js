import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../workspace-header.js';

/** @typedef {import('../workspace-header.js').AcpWorkspaceHeader} AcpWorkspaceHeader */
/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

const TASK = /** @type {Workspace} */ ({ id: 'w1', name: 'Fix login', creating: false, missing: false, error: null });

/**
 * @param {Workspace | null} workspace
 * @param {readonly string[]} [waiting] Other waiting workspaces' names.
 * @returns {Promise<{ el: AcpWorkspaceHeader, root: ShadowRoot, events: { type: string, detail: unknown }[] }>}
 */
async function render(workspace, waiting = /** @type {readonly string[]} */ ([])) {
  const el = /** @type {AcpWorkspaceHeader} */ (
    await fixture(html`<acp-workspace-header .workspace=${workspace} .waiting=${waiting}></acp-workspace-header>`)
  );
  /** @type {{ type: string, detail: unknown }[]} */
  const events = [];
  for (const type of ['acp-workspace-new-chat', 'acp-workspace-recreate', 'acp-workspace-delete-request', 'acp-workspace-next-waiting']) {
    el.addEventListener(type, (e) => events.push({ type, detail: /** @type {CustomEvent} */ (e).detail }));
  }
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot), events };
}

/** @param {ShadowRoot} root */
const banner = (root) => root.querySelector('[role="alert"]');

/** @param {ShadowRoot} root @param {string} label */
const button = (root, label) => /** @type {HTMLElement} */ ([...root.querySelectorAll('md-button, md-icon-button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label));

describe('acp-workspace-header', () => {
  it("names the shown workspace (Main without one) and starts a new chat in it", async () => {
    for (const [workspace, name] of /** @type {[Workspace | null, string][]} */ ([[TASK, 'Fix login'], [null, 'Main']])) {
      // Arrange
      const { root, events } = await render(workspace);
      const newChat = button(root, 'New chat');

      // Act
      newChat.click();

      // Assert
      expect(root.querySelector('h2')?.textContent?.trim(), name).to.equal(name);
      expect(tooltipOf(newChat)).to.equal('New chat');
      expect(events).to.deep.equal([{ type: 'acp-workspace-new-chat', detail: null }]);
      expect(banner(root), 'no banner').to.equal(null);
    }
  });

  it('shows an indeterminate bar while the workspace checks out', async () => {
    // Arrange + Act
    const { root: creating } = await render({ ...TASK, creating: true });
    const { root: ready } = await render(TASK);

    // Assert
    expect(creating.querySelector('md-progress-linear')?.getAttribute('aria-label')).to.equal('Creating workspace');
    expect(ready.querySelector('md-progress-linear')).to.equal(null);
  });

  it('offers Recreate folder and Delete for a missing folder, Retry and Delete for a failed checkout', async () => {
    /** @type {[Partial<Workspace>, string, string][]} */
    const cases = [
      [{ missing: true }, "This workspace's folder is missing", 'Recreate folder'],
      [{ error: 'fatal: invalid reference: nope' }, "Couldn't create the folder: fatal: invalid reference: nope", 'Retry'],
    ];
    for (const [state, message, recreate] of cases) {
      // Arrange
      const { root, events } = await render({ ...TASK, ...state });

      // Act
      button(root, recreate).click();
      button(root, 'Delete workspace').click();

      // Assert
      expect(banner(root)?.querySelector('.acp-workspace-header__message')?.textContent?.trim(), recreate).to.equal(message);
      expect(events, recreate).to.deep.equal([
        { type: 'acp-workspace-recreate', detail: { id: 'w1' } },
        { type: 'acp-workspace-delete-request', detail: { id: 'w1' } },
      ]);
    }
  });

  it('says which other workspaces wait, one by name, several by count, and goes to the next on click', async () => {
    /** @type {[string[], string | null][]} */
    const cases = [
      [[], null],
      [['Fix login'], 'Fix login is waiting for you'],
      [['Fix login', 'Main'], '2 workspaces waiting'],
    ];
    for (const [waiting, text] of cases) {
      // Arrange
      const { root, events } = await render(null, waiting);
      const strip = /** @type {HTMLElement | null} */ (root.querySelector('.acp-workspace-header__waiting'));

      // Act
      strip?.click();

      // Assert
      expect(strip?.textContent?.trim() ?? null, String(waiting)).to.equal(text);
      expect(events, String(waiting)).to.deep.equal(text === null ? [] : [{ type: 'acp-workspace-next-waiting', detail: null }]);
    }
  });
});
