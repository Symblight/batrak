import { html, nothing } from 'lit';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { $comments, $commentFocus } from '../../stores/comments/comments.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { WorkspaceChangesController } from '../../controllers/workspace-changes/WorkspaceChangesController.js';
import '../../components/changes-review/changes-review.js';
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
      @acp-change-toggle=${byId((id) => this.#review.toggle(id))}
      @acp-change-expand=${byId((id) => this.#review.expand(id))}
      @acp-changes-collapse=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#review.collapseAll();
      }}
      @acp-session-apply=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        workspaces.apply(view.workspaceId);
      }}
      @acp-session-check-out=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        workspaces.checkOut(view.workspaceId);
      }}
    ></acp-changes-review>`;
  }
}

customElements.define('acp-workspace-changes-tab', AcpWorkspaceChangesTab);
