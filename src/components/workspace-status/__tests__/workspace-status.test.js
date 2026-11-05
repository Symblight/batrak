import { expect, fixture, html } from '../../../../test/fixture.js';
import '../workspace-status.js';

/** @typedef {import('../workspace-status.js').AcpWorkspaceStatus} AcpWorkspaceStatus */
/** @typedef {import('../../../hooks/workspaces/types.js').WorkspaceStatus} WorkspaceStatus */

describe('acp-workspace-status', () => {
  it('shows a dot per status, named by its accessible label; a spinner while working', async () => {
    /** @type {[WorkspaceStatus, string, boolean][]} */
    const cases = [
      ['waiting', 'Waiting for you', false],
      ['error', 'Needs attention', false],
      ['working', 'Working', true],
      ['unread', 'Unread', false],
      ['idle', 'Idle', false],
    ];
    for (const [status, label, spinner] of cases) {
      // Arrange + Act
      const el = /** @type {AcpWorkspaceStatus} */ (await fixture(html`<acp-workspace-status .status=${status}></acp-workspace-status>`));
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);

      // Assert
      expect(root.querySelector('[role="img"]')?.getAttribute('aria-label'), status).to.equal(label);
      expect(root.querySelector('md-progress-circular') !== null, `${status}: spinner`).to.equal(spinner);
    }
  });
});
