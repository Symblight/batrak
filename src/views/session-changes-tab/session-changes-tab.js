import { html, nothing } from 'lit';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $comments, $commentFocus } from '../../stores/comments/comments.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { SessionChangesController } from '../../controllers/session-changes/SessionChangesController.js';
import '../../components/changes-review/changes-review.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/**
 * @tag acp-session-changes-tab
 * @summary A worktree session's Changes tab wired to its data: the files it changed since it started and their diffs, with Apply locally and Check out branch.
 */
export class AcpSessionChangesTab extends ViewElement {
  static properties = {
    sessionId: { attribute: false },
  };

  #review = new SessionChangesController(this, { sessionId: () => this.sessionId });
  #comments = new StoreController(this, { store: $comments });
  #commentFocus = new StoreController(this, { store: $commentFocus });

  constructor() {
    super();
    /** @type {string | null} The session whose tab this is. */
    this.sessionId = null;
  }

  /** @param {Map<string, unknown>} changed */
  willUpdate(changed) {
    if (changed.has('sessionId')) this.#review.sync();
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
    const byId = AcpSessionChangesTab.#byId;
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
        sessions.applyLocally(view.sessionId);
      }}
      @acp-session-check-out=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        sessions.checkOutBranch(view.sessionId);
      }}
    ></acp-changes-review>`;
  }
}

customElements.define('acp-session-changes-tab', AcpSessionChangesTab);
