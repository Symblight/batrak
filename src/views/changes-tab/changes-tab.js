import { html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { $comments, $commentFocus } from '../../stores/comments/comments.js';
import { $commitSelection, $gitChanges, $gitRepo, pickForCommit, setCommitSelection } from '../../stores/git/git.js';
import { $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ChangesReviewController } from '../../controllers/changes-review/ChangesReviewController.js';
import '../../components/changes-review/changes-review.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/**
 * @tag acp-changes-tab
 * @summary The project's Changes tab wired to its data: the changed files, the repository, the files picked for a commit, each file's diff and the comments.
 */
export class AcpChangesTab extends ViewElement {
  #review = new ChangesReviewController(this);
  #changes = new StoreController(this, { store: $gitChanges });
  #repo = new StoreController(this, { store: $gitRepo });
  #selection = new StoreController(this, { store: $commitSelection });
  #comments = new StoreController(this, { store: $comments });
  #commentFocus = new StoreController(this, { store: $commentFocus });
  #project = new StoreController(this, { store: $project });
  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-changes-review']>} */
  #reviewRef = createRef();

  /**
   * Shows a file's diff and scrolls it into view.
   * @param {string} rel Root-relative.
   */
  async reveal(rel) {
    this.#review.expand(rel);
    await this.updateComplete;
    await this.#reviewRef.value?.scrollToChange(rel);
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
    const byId = AcpChangesTab.#byId;
    return html`<acp-changes-review
      ${ref(this.#reviewRef)}
      .changes=${this.#changes.value}
      .repo=${this.#repo.value}
      .selection=${this.#selection.value}
      .expanded=${this.#review.expanded}
      .diffs=${this.#review.diffs}
      .root=${this.#project.value?.path ?? null}
      .comments=${this.#comments.value}
      .commentFocus=${this.#commentFocus.value}
      @acp-change-toggle=${byId((id) => this.#review.toggle(id))}
      @acp-change-expand=${byId((id) => this.#review.expand(id))}
      @acp-changes-collapse=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        this.#review.collapseAll();
      }}
      @acp-commit-pick=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        const { ids, picked } = /** @type {CustomEvent<{ ids: string[], picked: boolean }>} */ (e).detail;
        pickForCommit(ids, picked);
      }}
      @acp-commit-select=${(/** @type {Event} */ e) => {
        e.stopPropagation();
        setCommitSelection(/** @type {CustomEvent<{ ids: string[] }>} */ (e).detail.ids);
      }}
    ></acp-changes-review>`;
  }
}

customElements.define('acp-changes-tab', AcpChangesTab);
