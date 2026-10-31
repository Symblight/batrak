import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/code-editor';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import '../confirm-dialog/confirm-dialog.js';
import arrowDownwardIcon from '@material-design-icons/svg/outlined/arrow_downward.svg?raw';
import arrowDropDownIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import arrowUpwardIcon from '@material-design-icons/svg/outlined/arrow_upward.svg?raw';
import checkCircleIcon from '@material-design-icons/svg/outlined/check_circle.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import keyboardArrowDownIcon from '@material-design-icons/svg/outlined/keyboard_arrow_down.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import undoIcon from '@material-design-icons/svg/outlined/undo.svg?raw';
import unfoldLessIcon from '@material-design-icons/svg/outlined/unfold_less.svg?raw';
import { commentAuthor, editorPlugins } from '../../models/editor-plugins/editor-plugins.js';
import { absPath } from '../../models/paths/paths.js';
import { EditorCommentsController } from '../../controllers/comments/EditorCommentsController.js';
import { SelectionActionsController } from '../../controllers/selection-actions/SelectionActionsController.js';
import styles from './changes-review.css?inline';

/** @typedef {import('../../models/types/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../models/types/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../models/types/types.js').FileDiff} FileDiff */
/** @typedef {import('../../models/types/types.js').AgentThread} AgentThread */
/** @typedef {import('../../models/types/types.js').CommentFocus} CommentFocus */

/**
 * A changed file as a row.
 * @typedef {Object} ChangeRow
 * @property {string} id The file's root-relative path.
 * @property {string} name File name.
 * @property {string} dir Its folder, relative to the root; `''` at the top.
 * @property {GitFileStatus} file
 */

/** Disabled controls of features that don't exist yet say so on hover. */
const NOT_YET = 'Not available yet';

/** Unchanged stretches of a diff fold into an "N unchanged lines" bar; one object, so the editor never sees a change. */
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 4 };

/** Monospace badge of a file's type; no language colours, the badge only names the type. */
const TYPE_BADGES = /** @type {Record<string, string>} */ ({
  js: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  jsx: 'JSX',
  ts: 'TS',
  tsx: 'TSX',
  rs: 'RS',
  css: '{}',
  scss: '{}',
  json: '{}',
  html: '<>',
  md: 'MD',
  toml: 'TOML',
  yaml: 'YML',
  yml: 'YML',
});

/** @param {string} name */
function typeBadge(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '·';
  const ext = name.slice(dot + 1).toLowerCase();
  return TYPE_BADGES[ext] ?? ext.slice(0, 3).toUpperCase();
}

/**
 * Path of `to` relative to the folder `from`, both root-relative: `../old/name.css`.
 * @param {string} from
 * @param {string} to
 */
function relativePath(from, to) {
  const a = from ? from.split('/') : [];
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}

/** @param {GitFileStatus[]} files */
function toRows(files) {
  return files
    .map((file) => {
      const id = file.path;
      const slash = id.lastIndexOf('/');
      return { id, name: slash === -1 ? id : id.slice(slash + 1), dir: slash === -1 ? '' : id.slice(0, slash), file };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @tag acp-changes-review
 * @summary The Changes tab: every changed file as a row that expands into its diff against HEAD, picked for the next commit; with `base`, a worktree session's changes since that commit, nothing to pick.
 * @fires acp-file-open `{ path }` Edit was pressed on a file.
 * @fires acp-change-toggle `{ id }` A row was clicked: expand or collapse its diff.
 * @fires acp-change-expand `{ id }`
 * @fires acp-changes-collapse `null` Collapse all.
 * @fires acp-commit-pick `{ ids, picked }`
 * @fires acp-commit-select `{ ids }` Select all, or none.
 * @fires acp-session-apply `null` With `base`: Apply locally was pressed.
 * @fires acp-session-check-out `null` With `base`: Check out branch was confirmed.
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
    hovered: { state: true },
  };

  static styles = styles;

  #comments = new EditorCommentsController(this, {
    pathOf: (file) => absPath(this.root, file),
    comments: () => this.comments,
    focus: () => this.commentFocus,
  });
  #selectionActions = new SelectionActionsController(this, { pathOf: (file) => absPath(this.root, file) });
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
    /** @type {string | null} Row under the pointer or holding focus: it shows its actions. */
    this.hovered = null;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    const old = changed.get('changes');
    if (changed.has('changes') && this.changes.files !== old?.files) {
      this.#rows = toRows(this.changes.files);
      // A new listing without the file to scroll to: it has no row to scroll to.
      const pending = this.#pendingScroll;
      if (this.changes.loaded && pending !== null && !this.#rows.some((row) => row.id === pending)) this.#pendingScroll = null;
    }
    if (changed.has('root') && changed.get('root') !== undefined) {
      this.#pendingScroll = null;
      this.hovered = null;
    }
  }

  updated() {
    if (this.#pendingScroll === null) return;
    const row = this.renderRoot.querySelector(`[data-id="${CSS.escape(this.#pendingScroll)}"]`);
    if (!row) return; // not listed yet: try again once the changes arrive
    this.#pendingScroll = null;
    row.scrollIntoView({ block: 'start', behavior: 'smooth' });
    /** @type {HTMLElement} */ (row).focus({ preventScroll: true });
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

  /** @param {string} id */
  #toggle(id) {
    this.#emit('acp-change-toggle', { id });
  }

  /** @param {string} id */
  #expand(id) {
    if (!this.expanded.has(id)) this.#emit('acp-change-expand', { id });
  }

  /** @param {Event} e */
  #onToggleAll(e) {
    e.stopPropagation();
    const ids = this.#rows.map((row) => row.id);
    this.#emit('acp-commit-select', { ids: ids.every((id) => this.selection.has(id)) ? [] : ids });
  }

  /**
   * @param {Event} e
   * @param {ChangeRow} row
   */
  #onPick(e, row) {
    this.#emit('acp-commit-pick', { ids: [row.id], picked: /** @type {HTMLInputElement} */ (e.target).checked });
  }

  /**
   * Enter/Space toggle a row, arrows expand/collapse it.
   * @param {KeyboardEvent} e
   * @param {ChangeRow} row
   */
  #onRowKeydown(e, row) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') this.#toggle(row.id);
    else if (e.key === 'ArrowRight') this.#expand(row.id);
    else if (e.key === 'ArrowLeft' && this.expanded.has(row.id)) this.#toggle(row.id);
    else return;
    e.preventDefault();
  }

  /** @param {ChangeRow} row */
  #edit(row) {
    this.#emit('acp-file-open', { path: absPath(this.root, row.id) });
  }

  /** The project switches branch and the session's agent stops: asked first. */
  async #checkOut() {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('acp-confirm-dialog')
    );
    const confirmed = await dialog.confirm({
      headline: `Check out ${this.branch}?`,
      message: "The project switches to the session's branch, with its commits; the session's agent stops.",
      detail: 'The session goes on once the project is on another branch again.',
      confirmLabel: 'Check out',
    });
    if (confirmed) this.#emit('acp-session-check-out', null);
  }

  /** @param {string | null} id */
  #hover(id) {
    if (this.hovered !== id) this.hovered = id;
  }

  /**
   * @param {number | null} added
   * @param {number | null} removed
   */
  #renderCounts(added, removed) {
    if (!added && !removed) return nothing;
    return html`<span class="acp-changes-review__counts">
      ${added ? html`<span class="acp-changes-review__added">+${added}</span>` : nothing}
      ${removed ? html`<span class="acp-changes-review__removed">−${removed}</span>` : nothing}
    </span>`;
  }

  /**
   * @param {ChangeRow} row
   * @param {boolean} expanded Rendered as the expanded card's header, which always shows its actions.
   */
  #renderRow(row, expanded) {
    const { file } = row;
    const picked = this.selection.has(row.id);
    const deleted = file.kind === 'deleted';
    const actions = expanded || this.hovered === row.id;
    const id = `acp-changes-review-${row.id}`;
    return html`<div
      class=${classMap({
        'acp-changes-review__row': true,
        'acp-changes-review__row_header': expanded,
      })}
      role="treeitem"
      tabindex="0"
      data-id=${row.id}
      aria-expanded=${String(expanded)}
      @click=${() => this.#toggle(row.id)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onRowKeydown(e, row)}
      @pointerenter=${() => this.#hover(row.id)}
      @pointerleave=${() => this.#hover(null)}
      @focusin=${() => this.#hover(row.id)}
      @focusout=${() => this.#hover(null)}
    >
      <md-icon class="acp-changes-review__chevron">${unsafeSVG(expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
      ${this.base === null
        ? html`<md-checkbox
            class="acp-changes-review__pick"
            aria-label=${`Select ${row.name} for the commit`}
            .checked=${picked}
            @click=${(/** @type {Event} */ e) => e.stopPropagation()}
            @change=${(/** @type {Event} */ e) => this.#onPick(e, row)}
          ></md-checkbox>`
        : nothing}
      <span class="acp-changes-review__badge" aria-hidden="true">${typeBadge(row.name)}</span>
      <span id="${id}-name" class=${classMap({ 'acp-changes-review__name': true, 'acp-changes-review__name_deleted': deleted })}
        >${row.name}</span
      >
      <span class="acp-changes-review__dir">${row.dir}</span>
      ${file.origPath
        ? html`<span id="${id}-renamed" class="acp-changes-review__renamed"
            >(${relativePath(row.dir, file.origPath)})</span
          >`
        : nothing}
      ${this.#renderCounts(file.added, file.removed)}
      <span class="acp-changes-review__spacer"></span>
      ${actions
        ? html`<span class="acp-changes-review__actions" @click=${(/** @type {Event} */ e) => e.stopPropagation()}>
            <md-icon-button
              class="acp-changes-review__action"
              id="${id}-edit"
              aria-label=${`Edit ${row.name}`}
              ?disabled=${deleted}
              @click=${() => this.#edit(row)}
            >
              <md-icon class="acp-changes-review__action-icon">${unsafeSVG(editIcon)}</md-icon>
            </md-icon-button>
            <md-icon-button id="${id}-revert" class="acp-changes-review__action" aria-label=${`Revert ${row.name}`} disabled>
              <md-icon class="acp-changes-review__action-icon">${unsafeSVG(undoIcon)}</md-icon>
            </md-icon-button>
          </span>`
        : nothing}
    </div>
    <md-tooltip for="${id}-name" show-delay="800" style="width: max-content; max-inline-size: none">${file.path}</md-tooltip>
    ${file.origPath
      ? html`<md-tooltip for="${id}-renamed" show-delay="800" style="width: max-content; max-inline-size: none"
          >Renamed from ${file.origPath}</md-tooltip
        >`
      : nothing}
    ${actions
      ? html`<md-tooltip for="${id}-edit" show-delay="800">Edit</md-tooltip>
          <md-tooltip for="${id}-revert" show-delay="800">${NOT_YET}</md-tooltip>`
      : nothing}`;
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
      .plugins=${editorPlugins}
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
        .author=${commentAuthor}
        .comments=${this.#comments.threadsOf(absPath(this.root, row.id))}
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
      ${this.#renderCounts(added, removed)}
      <span class="acp-changes-review__spacer"></span>
      ${this.base !== null
        ? html`<md-button
              id="acp-changes-review-apply"
              class="acp-changes-review__session-action"
              variant="text"
              ?disabled=${total === 0}
              @click=${() => this.#emit('acp-session-apply', null)}
              >Apply locally</md-button
            >
            <md-button
              id="acp-changes-review-check-out"
              class="acp-changes-review__session-action"
              variant="text"
              @click=${this.#checkOut}
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
    return html`<div class="acp-changes-review__list" role="tree" aria-label="Changed files">
      ${repeat(this.#rows, (row) => row.id, (row) => this.#renderEntry(row))}
    </div>`;
  }

  render() {
    return html`${this.#renderToolbar()}${this.#renderBody()}${this.#selectionActions.render()}
      ${this.base !== null ? html`<acp-confirm-dialog></acp-confirm-dialog>` : nothing}`;
  }
}

customElements.define('acp-changes-review', AcpChangesReview);
