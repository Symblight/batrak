import { expect, fixture, html } from '../../../../test/fixture.js';
import '../workspace-delete-dialog.js';

/** @typedef {import('../workspace-delete-dialog.js').AcpWorkspaceDeleteDialog} AcpWorkspaceDeleteDialog */
/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../../hooks/workspaces/types.js').DeletePreview} DeletePreview */

const TASK = /** @type {Workspace} */ ({ id: 'w1', name: 'Fix login', branch: 'brama/fix-login' });

/**
 * @param {DeletePreview} preview
 * @returns {Promise<{ el: AcpWorkspaceDeleteDialog, root: ShadowRoot, deleted: unknown[] }>}
 */
async function shown(preview) {
  const el = /** @type {AcpWorkspaceDeleteDialog} */ (await fixture(html`<acp-workspace-delete-dialog></acp-workspace-delete-dialog>`));
  /** @type {unknown[]} */
  const deleted = [];
  el.addEventListener('acp-workspace-delete', (e) => deleted.push(/** @type {CustomEvent} */ (e).detail));
  await el.show(TASK, preview);
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot), deleted };
}

/** @param {ShadowRoot} root @param {string} cls */
const text = (root, cls) => root.querySelector(`.acp-workspace-delete-dialog__${cls}`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

/** @param {ShadowRoot} root */
const checkbox = (root) => /** @type {HTMLElementTagNameMap['md-checkbox'] | null} */ (root.querySelector('md-checkbox'));

describe('acp-workspace-delete-dialog', () => {
  it('says what deleting touches: the saved files, the kept branch, the chats it stops', async () => {
    /** @type {[DeletePreview, string | null, boolean, string | null][]} */
    const cases = [
      // [preview, note, Keep branch shown, working line]
      [{ uncommitted: 3, commits: 0, working: [] }, '3 uncommitted files will be saved as a commit on brama/fix-login', true, null],
      [{ uncommitted: 1, commits: 0, working: ['A'] }, '1 uncommitted file will be saved as a commit on brama/fix-login', true, '1 chat is working and will be stopped'],
      [{ uncommitted: 0, commits: 2, working: ['A', 'B'] }, null, true, '2 chats are working and will be stopped'],
      [{ uncommitted: 0, commits: 0, working: [] }, null, false, null],
    ];
    for (const [preview, note, keep, working] of cases) {
      // Arrange + Act
      const { root } = await shown(preview);

      // Assert
      const why = JSON.stringify(preview);
      expect(text(root, 'headline'), why).to.equal('Delete Fix login?');
      expect(text(root, 'note'), why).to.equal(note);
      expect(checkbox(root)?.checked ?? false, `${why}: Keep branch, on`).to.equal(keep);
      expect(text(root, 'working'), why).to.equal(working);
    }
  });

  it('deletes on Delete with the Keep branch choice; Cancel deletes nothing', async () => {
    /** @type {[DeletePreview, boolean, string, unknown[]][]} */
    const cases = [
      [{ uncommitted: 0, commits: 2, working: [] }, false, 'delete', [{ id: 'w1', keepBranch: true }]],
      [{ uncommitted: 0, commits: 2, working: [] }, true, 'delete', [{ id: 'w1', keepBranch: false }]],
      [{ uncommitted: 0, commits: 0, working: [] }, false, 'delete', [{ id: 'w1', keepBranch: false }]],
      [{ uncommitted: 2, commits: 0, working: [] }, false, 'cancel', []],
    ];
    for (const [preview, untick, button, expected] of cases) {
      // Arrange
      const { el, root, deleted } = await shown(preview);
      const box = checkbox(root);
      if (untick && box) {
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Act
      /** @type {HTMLElement} */ (root.querySelector(`.acp-workspace-delete-dialog__${button}`)).click();
      await el.updateComplete;

      // Assert
      expect(deleted, `${button}, untick ${untick}`).to.deep.equal(expected);
      expect(/** @type {HTMLElementTagNameMap['md-dialog']} */ (root.querySelector('md-dialog')).open).to.equal(false);
    }
  });
});
