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
import { StoreController } from '../../controllers/store/StoreController.js';
import { gitController } from '../../services/git-controller.js';
import { gitFileAtHead, readFile } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { $commitSelection, $gitChanges, $gitHead, $gitRepo, pickForCommit, setCommitSelection } from '../../stores/git.js';
import { $rootId } from '../../stores/workspace.js';
import { commentAuthor, editorPlugins } from '../../models/editor-plugins.js';
import styles from './acp-changes-review.css?inline';

/** @typedef {import('../../models/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../models/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */

/**
 * A changed file as a row.
 * @typedef {Object} ChangeRow
 * @property {string} id The file's root-relative path.
 * @property {string} name File name.
 * @property {string} dir Its folder, relative to the root; `''` at the top.
 * @property {GitFileStatus} file
 */

/**
 * An expanded file's diff: the file now against the file at HEAD.
 * @typedef {Object} FileDiff
 * @property {string} content `''` for a deleted file.
 * @property {string} baseline `''` for a new file.
 * @property {string} error
 * @property {boolean} loading
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

/**
 * Whether two status entries of one file describe the same change.
 * @param {GitFileStatus | undefined} a
 * @param {GitFileStatus | undefined} b
 */
function sameStatus(a, b) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.kind === b.kind &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.origPath === b.origPath &&
    a.added === b.added &&
    a.removed === b.removed
  );
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
 * @summary The Changes tab: every changed file as a row that expands into its diff against HEAD; kept current while active.
 * @fires acp-file-open `{ path }` Edit was pressed on a file.
 */
export class AcpChangesReview extends LitElement {
  static properties = {
    active: { type: Boolean },
    expanded: { state: true },
    diffs: { state: true },
    hovered: { state: true },
  };

  static styles = styles;

  #changes = new StoreController(this, { store: $gitChanges, onChange: (changes, old) => this.#onChanges(changes, old) });
  /**
   * HEAD moved: every diff's baseline is stale; read again with the status refresh that follows.
   * Not when HEAD first becomes known.
   */
  #gitHead = new StoreController(this, {
    store: $gitHead,
    onChange: (_head, old) => {
      if (old == null) return;
      for (const id of this.expanded) this.#staleDiffs.add(id);
    },
  });
  /** @type {Set<string>} Expanded files whose diff must be read again, once the status is current. */
  #staleDiffs = new Set();
  /** @type {string | null} Root whose files are expanded and diffed. */
  #shownRoot = null;
  /** @type {Map<string, ReadonlySet<string>>} Expanded files of the other open roots, by root id. */
  #expandedByRoot = new Map();
  #rootId = new StoreController(this, { store: $rootId, onChange: (rootId) => this.#switchRoot(rootId) });
  #onFsChange = (/** @type {Event} */ e) => {
    const { added, modified, removed } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const id of [...added, ...modified, ...removed]) {
      if (this.expanded.has(id)) this.#staleDiffs.add(id);
    }
  };
  #repo = new StoreController(this, { store: $gitRepo });
  #selection = new StoreController(this, { store: $commitSelection });
  /** @type {(() => void) | null} Stops watching; set while active and connected. */
  #unwatch = null;
  /** @type {ChangeRow[]} */
  #rows = [];
  /** @type {string | null} A file to scroll to once its row is rendered. */
  #pendingScroll = null;
  /** @type {Map<string, number>} Latest diff read per file; an older one that resolves later is dropped. */
  #loads = new Map();
  #loadCount = 0;

  constructor() {
    super();
    /** @type {boolean} The active tab: changes are computed and kept current. */
    this.active = false;
    /** @type {ReadonlySet<string>} Files shown with their diff. */
    this.expanded = new Set();
    /** @type {ReadonlyMap<string, FileDiff>} */
    this.diffs = new Map();
    /** @type {string | null} Row under the pointer or holding focus: it shows its actions. */
    this.hovered = null;
  }

  connectedCallback() {
    super.connectedCallback();
    projectController.addEventListener('fs-change', this.#onFsChange);
    if (this.active) this.#watch();
  }

  disconnectedCallback() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
    this.#stopWatching();
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues} changed */
  willUpdate(changed) {
    if (!changed.has('active')) return;
    if (this.active) this.#watch();
    else this.#stopWatching();
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
   * Expands a changed file and scrolls to it, now or once the changes are listed.
   * @param {string} id Root-relative path of the file.
   */
  reveal(id) {
    this.#expand(id);
    this.#pendingScroll = id;
    this.requestUpdate();
  }

  #watch() {
    this.#unwatch ??= gitController.watchChanges();
  }

  #stopWatching() {
    this.#unwatch?.();
    this.#unwatch = null;
  }

  /**
   * New status: rows follow it, and a diff is read again only when its file changed (on disk, in
   * the status, or HEAD moved). A check that found nothing new keeps the same `files` array.
   * @param {GitChangesView} changes
   * @param {GitChangesView | undefined} old
   */
  #onChanges({ files, loaded, loading }, old) {
    if (files !== old?.files) {
      const previous = new Map(this.#rows.map((row) => [row.id, row.file]));
      this.#rows = toRows(files);
      if (loaded) {
        const ids = new Set(this.#rows.map((row) => row.id));
        if (this.#pendingScroll !== null && !ids.has(this.#pendingScroll)) this.#pendingScroll = null;
        const expanded = [...this.expanded].filter((id) => ids.has(id));
        if (expanded.length !== this.expanded.size) this.expanded = new Set(expanded);
        for (const row of this.#rows) {
          if (this.expanded.has(row.id) && !sameStatus(previous.get(row.id), row.file)) this.#staleDiffs.add(row.id);
        }
      }
    }
    if (loaded && !loading) this.#flushStaleDiffs();
  }

  /**
   * Another project: its own expanded files come back, but no diff is carried over — paths repeat
   * across projects, and the files may have changed while it was inactive.
   * @param {string | null} rootId
   */
  #switchRoot(rootId) {
    const previous = this.#shownRoot;
    if (previous === rootId) return;
    this.#shownRoot = rootId;
    if (previous !== null && projectController.isOpen(previous)) this.#expandedByRoot.set(previous, this.expanded);
    for (const id of this.#expandedByRoot.keys()) {
      if (!projectController.isOpen(id)) this.#expandedByRoot.delete(id);
    }
    const saved = rootId === null ? undefined : this.#expandedByRoot.get(rootId);
    if (rootId !== null) this.#expandedByRoot.delete(rootId);
    this.expanded = new Set(saved);
    this.diffs = new Map();
    this.#loads.clear(); // reads still in flight belong to the other project
    this.#staleDiffs.clear();
    this.#pendingScroll = null;
    const { loaded, loading } = this.#changes.value;
    if (loaded && !loading) this.#flushStaleDiffs();
  }

  /** Reads the stale diffs again, and those of expanded files never read. */
  #flushStaleDiffs() {
    for (const row of this.#rows) {
      if (!this.expanded.has(row.id)) continue;
      if (this.#staleDiffs.has(row.id) || !this.diffs.has(row.id)) this.#loadDiff(row.id);
    }
    this.#staleDiffs.clear();
  }

  /** @param {string} id */
  #expand(id) {
    if (this.expanded.has(id)) return;
    this.expanded = new Set([...this.expanded, id]);
    if (this.#rows.some((row) => row.id === id)) this.#loadDiff(id);
  }

  /** @param {string} id */
  #toggle(id) {
    if (!this.expanded.has(id)) {
      this.#expand(id);
      return;
    }
    const next = new Set(this.expanded);
    next.delete(id);
    this.expanded = next;
  }

  /**
   * Reads a file and its HEAD version for its diff: a deleted file is nothing against HEAD, a new
   * one is the file against nothing.
   * @param {string} id
   */
  async #loadDiff(id) {
    this.#staleDiffs.delete(id);
    const load = ++this.#loadCount;
    this.#loads.set(id, load);
    const previous = this.diffs.get(id);
    if (!previous) this.#setDiff(id, { content: '', baseline: '', error: '', loading: true });
    const rootId = projectController.rootId;
    const path = projectController.absPath(id);
    const [content, baseline] = await Promise.all([
      readFile(path).catch(() => null),
      rootId ? gitFileAtHead(rootId, id).catch(() => null) : Promise.resolve(null),
    ]);
    if (this.#loads.get(id) !== load) return;
    this.#setDiff(
      id,
      content === null && baseline === null
        ? { content: '', baseline: '', error: `${id}: neither on disk nor in HEAD`, loading: false }
        : { content: content ?? '', baseline: baseline ?? '', error: '', loading: false },
    );
  }

  /**
   * @param {string} id
   * @param {FileDiff} diff
   */
  #setDiff(id, diff) {
    this.diffs = new Map(this.diffs).set(id, diff);
  }

  /** @param {Event} e */
  #onToggleAll(e) {
    e.stopPropagation();
    const ids = this.#rows.map((row) => row.id);
    const selection = this.#selection.value;
    setCommitSelection(ids.every((id) => selection.has(id)) ? [] : ids);
  }

  /**
   * @param {Event} e
   * @param {ChangeRow} row
   */
  #onPick(e, row) {
    pickForCommit([row.id], /** @type {HTMLInputElement} */ (e.target).checked);
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
    this.dispatchEvent(
      new CustomEvent('acp-file-open', {
        detail: { path: projectController.absPath(row.id) },
        bubbles: true,
        composed: true,
      }),
    );
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
    const picked = this.#selection.value.has(row.id);
    const deleted = file.kind === 'deleted';
    const actions = expanded || this.hovered === row.id;
    return html`<div
      class=${classMap({
        'acp-changes-review__row': true,
        'acp-changes-review__row_header': expanded,
      })}
      role="treeitem"
      tabindex="0"
      data-id=${row.id}
      aria-expanded=${String(expanded)}
      title=${row.file.path}
      @click=${() => this.#toggle(row.id)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onRowKeydown(e, row)}
      @pointerenter=${() => this.#hover(row.id)}
      @pointerleave=${() => this.#hover(null)}
      @focusin=${() => this.#hover(row.id)}
      @focusout=${() => this.#hover(null)}
    >
      <md-icon class="acp-changes-review__chevron">${unsafeSVG(expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
      <md-checkbox
        class="acp-changes-review__pick"
        aria-label=${`Select ${row.name} for the commit`}
        .checked=${picked}
        @click=${(/** @type {Event} */ e) => e.stopPropagation()}
        @change=${(/** @type {Event} */ e) => this.#onPick(e, row)}
      ></md-checkbox>
      <span class="acp-changes-review__badge" aria-hidden="true">${typeBadge(row.name)}</span>
      <span class=${classMap({ 'acp-changes-review__name': true, 'acp-changes-review__name_deleted': deleted })}
        >${row.name}</span
      >
      <span class="acp-changes-review__dir">${row.dir}</span>
      ${file.origPath
        ? html`<span class="acp-changes-review__renamed" title="Renamed from ${file.origPath}"
            >(${relativePath(row.dir, file.origPath)})</span
          >`
        : nothing}
      ${this.#renderCounts(file.added, file.removed)}
      <span class="acp-changes-review__spacer"></span>
      ${actions
        ? html`<span class="acp-changes-review__actions" @click=${(/** @type {Event} */ e) => e.stopPropagation()}>
            <md-icon-button
              class="acp-changes-review__action"
              aria-label=${`Edit ${row.name}`}
              title="Edit"
              ?disabled=${deleted}
              @click=${() => this.#edit(row)}
            >
              <md-icon class="acp-changes-review__action-icon">${unsafeSVG(editIcon)}</md-icon>
            </md-icon-button>
            <md-icon-button class="acp-changes-review__action" aria-label=${`Revert ${row.name}`} title=${NOT_YET} disabled>
              <md-icon class="acp-changes-review__action-icon">${unsafeSVG(undoIcon)}</md-icon>
            </md-icon-button>
          </span>`
        : nothing}
    </div>`;
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
      <cdx-comments slot="comments" mode="single" .author=${commentAuthor}></cdx-comments>
      <cdx-comments-bar slot="comments-bar"></cdx-comments-bar>
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
    const selection = this.#selection.value;
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
        class="acp-changes-review__tool"
        aria-label="Collapse all"
        title="Collapse all"
        ?disabled=${this.expanded.size === 0}
        @click=${() => (this.expanded = new Set())}
      >
        <md-icon class="acp-changes-review__tool-icon">${unsafeSVG(unfoldLessIcon)}</md-icon>
      </md-icon-button>
      <md-checkbox
        class="acp-changes-review__all"
        aria-label="Select all changed files"
        ?disabled=${total === 0}
        .checked=${total > 0 && picked === total}
        .indeterminate=${picked > 0 && picked < total}
        @change=${this.#onToggleAll}
      ></md-checkbox>
      <span class="acp-changes-review__summary">${picked}/${total} files selected</span>
      ${this.#renderCounts(added, removed)}
      <span class="acp-changes-review__spacer"></span>
      <span class="acp-changes-review__tools">
        <md-button class="acp-changes-review__view-mode" variant="text" title=${NOT_YET} disabled>
          Unified
          <md-icon slot="icon" class="acp-changes-review__tool-icon">${unsafeSVG(arrowDropDownIcon)}</md-icon>
        </md-button>
        <md-icon-button class="acp-changes-review__tool" aria-label="Next change" title=${NOT_YET} disabled>
          <md-icon class="acp-changes-review__tool-icon">${unsafeSVG(arrowDownwardIcon)}</md-icon>
        </md-icon-button>
        <md-icon-button class="acp-changes-review__tool" aria-label="Previous change" title=${NOT_YET} disabled>
          <md-icon class="acp-changes-review__tool-icon">${unsafeSVG(arrowUpwardIcon)}</md-icon>
        </md-icon-button>
        <md-icon-button class="acp-changes-review__tool" aria-label="Revert all" title=${NOT_YET} disabled>
          <md-icon class="acp-changes-review__tool-icon">${unsafeSVG(undoIcon)}</md-icon>
        </md-icon-button>
        <span class="acp-changes-review__review">
          <md-button class="acp-changes-review__review-main" variant="tonal" title=${NOT_YET} disabled>
            <md-icon slot="icon" class="acp-changes-review__review-icon">${unsafeSVG(terminalIcon)}</md-icon>
            Review with agent
          </md-button>
          <md-icon-button class="acp-changes-review__review-menu" aria-label="Choose agent" title=${NOT_YET} disabled>
            <md-icon class="acp-changes-review__review-icon">${unsafeSVG(keyboardArrowDownIcon)}</md-icon>
          </md-icon-button>
        </span>
      </span>
    </header>`;
  }

  #renderBody() {
    const { loaded, loading, error } = this.#changes.value;
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
    if (loaded && !this.#repo.value.repo) {
      return html`<div class="acp-changes-review__state">
        <b class="acp-changes-review__state-title">Not a git repository</b>
      </div>`;
    }
    if (this.#rows.length === 0) {
      return html`<div class="acp-changes-review__state">
        <md-icon class="acp-changes-review__state-icon">${unsafeSVG(checkCircleIcon)}</md-icon>
        <b class="acp-changes-review__state-title">No changes</b>
        <span>The working tree matches HEAD.</span>
      </div>`;
    }
    return html`<div class="acp-changes-review__list" role="tree" aria-label="Changed files">
      ${repeat(this.#rows, (row) => row.id, (row) => this.#renderEntry(row))}
    </div>`;
  }

  render() {
    return html`${this.#renderToolbar()}${this.#renderBody()}`;
  }
}

customElements.define('acp-changes-review', AcpChangesReview);
