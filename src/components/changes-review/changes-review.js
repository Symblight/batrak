import { git } from '../../hooks/git/git.js';
import { projects } from '../../hooks/projects/projects.js';
import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/code-editor';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import checkCircleIcon from '@material-design-icons/svg/outlined/check_circle.svg?raw';
import unfoldLessIcon from '@material-design-icons/svg/outlined/unfold_less.svg?raw';
import '../change-row/change-row.js';
import { codeEditor } from '../code-view/code-editor.js';
import '../diff-counts/diff-counts.js';
import { EditorCommentsController } from '../../controllers/comments/EditorCommentsController.js';
import { TreeNavigationController } from '../../controllers/tree-navigation/TreeNavigationController.js';
import { SelectionActionsController } from '../../controllers/selection-actions/SelectionActionsController.js';
import styles from './changes-review.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/tabs/types.js').FileDiff} FileDiff */
/** @typedef {import('../../hooks/comments/types.js').AgentThread} AgentThread */
/** @typedef {import('../../hooks/comments/types.js').CommentFocus} CommentFocus */

/** @typedef {import('../../hooks/git/changes.js').ChangeRow} ChangeRow */

/** Unchanged stretches of a diff fold into an "N unchanged lines" bar; one object, so the editor never sees a change. */
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 4 };

/**
 * @tag acp-changes-review
 * @summary The Changes tab: every changed file as a row that expands into its diff against HEAD, picked for the next commit; with `base`, a worktree session's changes since that commit, nothing to pick.
 * @fires acp-file-open `{ path }` Edit was pressed on a file.
 * @fires acp-change-toggle `{ id }` A row was clicked: expand or collapse its diff.
 * @fires acp-change-expand `{ id }`
 * @fires acp-changes-collapse `null` Collapse all.
 * @fires acp-commit-pick `{ ids, picked }`
 * @fires acp-commit-select `{ ids }` Select all, or none.
 * @fires acp-changes-apply `null` With `base`: Apply locally was pressed.
 * @fires acp-changes-check-out `null` With `base`: Check out branch was pressed; its view asks first.
 */
export class AcpChangesReview extends LitElement {
  static properties = {
    changes: { attribute: false },
    repo: { attribute: false },
    selection: { attribute: false },
    expanded: { attribute: false },
    diffs: { attribute: false },
    root: { attribute: false },
    base: { attribute: false },
    branch: { attribute: false },
    comments: { attribute: false },
    commentFocus: { attribute: false },
  };

  static styles = styles;

  #comments = new EditorCommentsController(this, {
    pathOf: (file) => projects.abs(this.root, file),
    comments: () => this.comments,
    focus: () => this.commentFocus,
  });
  #selectionActions = new SelectionActionsController(this, { pathOf: (file) => projects.abs(this.root, file) });
  /** The files are rows of a flat tree; opening a diff is the row's own business. */
  #tree = new TreeNavigationController(this, {
    nodes: () =>
      [...this.renderRoot.querySelectorAll('acp-change-row')].flatMap((el) =>
        el.row ? [{ key: el.row.id, el, label: el.row.name, parent: null, expanded: el.expanded }] : [],
      ),
  });
  /** @type {ChangeRow[]} */
  #rows = [];
  /** @type {string | null} A file to scroll to once its row is rendered. */
  #pendingScroll = null;

  constructor() {
    super();
    /** @type {GitChangesView} */
    this.changes = { files: [], loaded: false, loading: false, error: null };
    /** @type {GitRepoView} */
    this.repo = { repo: null, error: null };
    /** @type {ReadonlySet<string>} Files picked for the next commit. */
    this.selection = new Set();
    /** @type {ReadonlySet<string>} Files shown with their diff. */
    this.expanded = new Set();
    /** @type {ReadonlyMap<string, FileDiff>} */
    this.diffs = new Map();
    /** @type {string | null} The project's path (a worktree session's folder with `base`); ids are relative to it. */
    this.root = null;
    /** @type {string | null} A worktree session's base commit: its changes since then, read-only. */
    this.base = null;
    /** @type {string | null} With `base`: the session's branch, which Check out branch hands to the project. */
    this.branch = null;
    /** @type {Readonly<Record<string, readonly AgentThread[]>>} Every file's comments, by absolute path. */
    this.comments = {};
    /** @type {CommentFocus | null} */
    this.commentFocus = null;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    const old = changed.get('changes');
    if (changed.has('changes') && this.changes.files !== old?.files) {
      this.#rows = git.changeRows(this.changes.files);
      // A new listing without the file to scroll to: it has no row to scroll to.
      const pending = this.#pendingScroll;
      if (this.changes.loaded && pending !== null && !this.#rows.some((row) => row.id === pending)) this.#pendingScroll = null;
    }
    if (changed.has('root') && changed.get('root') !== undefined) this.#pendingScroll = null;
  }

  updated() {
    if (this.#pendingScroll === null) return;
    const row = /** @type {HTMLElementTagNameMap['acp-change-row'] | null} */ (
      this.renderRoot.querySelector(`acp-change-row[data-id="${CSS.escape(this.#pendingScroll)}"]`)
    );
    if (!row) return; // not listed yet: try again once the changes arrive
    this.#pendingScroll = null;
    this.#reveal(row);
  }

  /**
   * Scrolls to a row and focuses it. Rows added by this update have not rendered yet and are 0px
   * tall, which would put the scroll target too high: wait for all of them first.
   * @param {HTMLElementTagNameMap['acp-change-row']} row
   */
  async #reveal(row) {
    await Promise.all([...this.renderRoot.querySelectorAll('acp-change-row')].map((r) => r.updateComplete));
    row.scrollIntoView({ block: 'start', behavior: 'smooth' });
    row.focusRow();
  }

  /**
   * Scrolls to a changed file's row, now or once the changes are listed.
   * @param {string} id Root-relative path of the file.
   */
  scrollToChange(id) {
    this.#pendingScroll = id;
    this.requestUpdate();
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onToggleAll(e) {
    e.stopPropagation();
    const ids = this.#rows.map((row) => row.id);
    this.#emit('acp-commit-select', { ids: ids.every((id) => this.selection.has(id)) ? [] : ids });
  }

  /** @param {Event} e A row's Edit. */
  #onEdit(e) {
    e.stopPropagation();
    const { id } = /** @type {CustomEvent<{ id: string }>} */ (e).detail;
    this.#emit('acp-file-open', { path: projects.abs(this.root, id) });
  }

  /**
   * @param {ChangeRow} row
   * @param {boolean} expanded Rendered as the expanded card's header, which always shows its actions.
   */
  #renderRow(row, expanded) {
    return html`<acp-change-row
      data-id=${row.id}
      .row=${row}
      .expanded=${expanded}
      .picked=${this.selection.has(row.id)}
      .selectable=${this.base === null}
      @acp-change-edit=${this.#onEdit}
    ></acp-change-row>`;
  }

  /** @param {ChangeRow} row */
  #renderDiff(row) {
    const diff = this.diffs.get(row.id);
    if (!diff || (diff.loading && !diff.content && !diff.baseline)) {
      return html`<div class="acp-changes-review__diff-state">
        <md-progress-circular class="acp-changes-review__spinner" aria-label="Loading diff"></md-progress-circular>
      </div>`;
    }
    if (diff.error) return html`<div class="acp-changes-review__diff-state">${diff.error}</div>`;
    return html`<cdx-code-editor
      class="acp-changes-review__editor"
      read-only
      aria-label=${`Diff of ${row.name}`}
      .plugins=${codeEditor.plugins}
      filename=${row.file.path}
      .value=${diff.content}
      .reviewBase=${diff.baseline}
    >
      <!-- Review, not baseline: only it folds unchanged lines. Its Accept/Reject are hidden in CSS. -->
      <cdx-diff slot="diff" kind="review" no-review-bar .collapseUnchanged=${COLLAPSE_UNCHANGED}></cdx-diff>
      <cdx-comments
        slot="comments"
        mode="single"
        .noResolve=${true}
        .author=${codeEditor.author}
        .comments=${this.#comments.threadsOf(projects.abs(this.root, row.id))}
      ></cdx-comments>
    </cdx-code-editor>`;
  }

  /** @param {ChangeRow} row */
  #renderEntry(row) {
    if (!this.expanded.has(row.id)) return this.#renderRow(row, false);
    return html`<div class="acp-changes-review__card">
      ${this.#renderRow(row, true)}
      <div class="acp-changes-review__diff">${this.#renderDiff(row)}</div>
    </div>`;
  }

  #renderToolbar() {
    const total = this.#rows.length;
    const selection = this.selection;
    const picked = this.#rows.filter((row) => selection.has(row.id)).length;
    /** @type {number | null} */
    let added = null;
    /** @type {number | null} */
    let removed = null;
    for (const { file } of this.#rows) {
      if (file.added !== null) added = (added ?? 0) + file.added;
      if (file.removed !== null) removed = (removed ?? 0) + file.removed;
    }
    return html`<header class="acp-changes-review__toolbar">
      <md-icon-button
        id="acp-changes-review-collapse"
        class="acp-changes-review__tool"
        aria-label="Collapse all"
        ?disabled=${this.expanded.size === 0}
        @click=${() => this.#emit('acp-changes-collapse', null)}
      >
        <md-icon class="acp-changes-review__tool-icon">${unsafeSVG(unfoldLessIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-changes-review-collapse" show-delay="800">Collapse all</md-tooltip>
      ${this.base === null
        ? html`<md-checkbox
              class="acp-changes-review__all"
              aria-label="Select all changed files"
              ?disabled=${total === 0}
              .checked=${total > 0 && picked === total}
              .indeterminate=${picked > 0 && picked < total}
              @change=${this.#onToggleAll}
            ></md-checkbox>
            <span class="acp-changes-review__summary">${picked}/${total} files selected</span>`
        : html`<span class="acp-changes-review__summary"
            >${total} ${total === 1 ? 'file' : 'files'} changed since ${this.base.slice(0, 7)}</span
          >`}
      <acp-diff-counts .added=${added} .removed=${removed}></acp-diff-counts>
      <span class="acp-changes-review__spacer"></span>
      ${this.base !== null
        ? html`<md-button
              id="acp-changes-review-apply"
              class="acp-changes-review__session-action"
              variant="text"
              ?disabled=${total === 0}
              @click=${() => this.#emit('acp-changes-apply', null)}
              >Apply locally</md-button
            >
            <md-button
              id="acp-changes-review-check-out"
              class="acp-changes-review__session-action"
              variant="text"
              @click=${() => this.#emit('acp-changes-check-out', null)}
              >Check out branch</md-button
            >
            <md-tooltip for="acp-changes-review-apply" show-delay="800">Bring the changes into the project, unstaged</md-tooltip>
            <md-tooltip for="acp-changes-review-check-out" show-delay="800">Check ${this.branch} out in the project</md-tooltip>`
        : nothing}
    </header>`;
  }

  #renderBody() {
    const { loaded, loading, error } = this.changes;
    if (loading && !loaded) {
      return html`<div class="acp-changes-review__state">
        <md-progress-circular class="acp-changes-review__spinner" aria-label="Loading changes"></md-progress-circular>
      </div>`;
    }
    if (error) {
      return html`<div class="acp-changes-review__state" role="alert">
        <b class="acp-changes-review__state-title">Couldn't read changes</b><span>${error}</span>
      </div>`;
    }
    if (loaded && !this.repo.repo && this.base === null) {
      return html`<div class="acp-changes-review__state">
        <b class="acp-changes-review__state-title">Not a git repository</b>
      </div>`;
    }
    if (this.#rows.length === 0) {
      return html`<div class="acp-changes-review__state">
        <md-icon class="acp-changes-review__state-icon">${unsafeSVG(checkCircleIcon)}</md-icon>
        <b class="acp-changes-review__state-title">No changes</b>
        <span>${this.base === null ? 'The working tree matches HEAD.' : 'Nothing changed since the session started.'}</span>
      </div>`;
    }
    return html`<div class="acp-changes-review__list" role="tree" aria-label="Changed files" @keydown=${this.#tree.onKeydown} @focusin=${this.#tree.onFocusin}>
      ${repeat(this.#rows, (row) => row.id, (row) => this.#renderEntry(row))}
    </div>`;
  }

  render() {
    return html`${this.#renderToolbar()}${this.#renderBody()}${this.#selectionActions.render()}`;
  }
}

customElements.define('acp-changes-review', AcpChangesReview);
