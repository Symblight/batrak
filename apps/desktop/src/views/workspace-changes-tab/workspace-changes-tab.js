import { html, nothing } from 'lit';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { $comments, $commentFocus } from '../../stores/comments/comments.js';
import { $diffLayout, setDiffLayout } from '../../stores/git/git.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { WorkspaceChangesController } from '../../controllers/workspace-changes/WorkspaceChangesController.js';
import '../../components/changes-review/changes-review.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/**
 * @tag acp-workspace-changes-tab
 * @summary A workspace's Changes tab wired to its data: the files changed since its base and their diffs, with Apply to Main and Check out branch.
 */
export class AcpWorkspaceChangesTab extends ViewElement {
  static properties = {
    workspaceId: { attribute: false },
  };

  #review = new WorkspaceChangesController(this, { workspaceId: () => this.workspaceId });
  #comments = new StoreController(this, { store: $comments });
  #commentFocus = new StoreController(this, { store: $commentFocus });
  #diffLayout = new StoreController(this, { store: $diffLayout });

  constructor() {
    super();
    /** @type {string | null} The workspace whose tab this is. */
    this.workspaceId = null;
  }

  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    if (changed.has('workspaceId')) this.#review.sync();
  }

  /**
   * @param {(id: string) => unknown} act
   * @returns {(e: Event) => void}
   */
  static #byId(act) {
    return (e) => {
      e.stopPropagation();
      act(/** @type {CustomEvent<{ id: string }>} */ (e).detail.id);
    };
  }

  /**
   * The project switches branch and the session's agent stops: asked first.
   * @param {string} id
   * @param {string | null} branch
   */
  async #confirmCheckOut(id, branch) {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.renderRoot.querySelector('acp-confirm-dialog'));
    const confirmed = await dialog.confirm({
      headline: `Check out ${branch}?`,
      message: "The project switches to the session's branch, with its commits; the session's agent stops.",
      detail: 'The session goes on once the project is on another branch again.',
      confirmLabel: 'Check out',
    });
    if (confirmed) workspaces.checkOut(id);
  }

  render() {
    const view = this.#review.view;
    if (!view) return nothing;
    const byId = AcpWorkspaceChangesTab.#byId;
    return html`<acp-changes-review
      .changes=${view.changes}
      .expanded=${view.expanded}
      .diffs=${view.diffs}
      .root=${view.folder}
      .base=${view.base}
      .branch=${view.branch}
      .comments=${this.#comments.value}
      .commentFocus=${this.#commentFocus.value}
      .diffLayout=${this.#diffLayout.value}
      @acp-change-toggle=${byId((id) => this.#review.toggle(id))}
      @acp-change-expand=${byId((id) => this.#review.expand(id))}
      @acp-changes-collapse=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#review.collapseAll();
      }}
      @acp-diff-layout=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        setDiffLayout(/** @type {CustomEvent<{ layout: import('../../hooks/git/types.js').DiffLayout }>} */ (e).detail.layout);
      }}
      @acp-changes-apply=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        workspaces.apply(view.workspaceId);
      }}
      @acp-changes-check-out=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        void this.#confirmCheckOut(view.workspaceId, view.branch);
      }}
    ></acp-changes-review>
      <acp-confirm-dialog></acp-confirm-dialog>`;
  }
}

customElements.define('acp-workspace-changes-tab', AcpWorkspaceChangesTab);
