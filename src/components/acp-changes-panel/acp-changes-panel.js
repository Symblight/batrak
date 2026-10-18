import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/text-field';
import '@symblight/wc-material/tooltip';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import checkCircleIcon from '@material-design-icons/svg/outlined/check_circle.svg?raw';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { absPath } from '../../models/paths.js';
import styles from './acp-changes-panel.css?inline';

/** @typedef {import('../../models/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../models/types.js').GitFileKind} GitFileKind */
/** @typedef {import('../../models/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types.js').GitRepoView} GitRepoView */
/** @typedef {'changes' | 'untracked'} ChangeGroup */

/**
 * A row of the changes list: a group (as in `git status`: tracked changes, untracked files) or a
 * changed file in it. Files are what a commit takes.
 * @typedef {Object} ChangeNode
 * @property {string} id A file's root-relative path; `group:<name>` for a group.
 * @property {string} label File name, or the group's title.
 * @property {string} dir Folder of a file, relative to the root (`''` at the top); `''` for a group.
 * @property {GitFileStatus | null} file `null` for a group.
 * @property {number | null} added Summed over a group; `null` when no count is known.
 * @property {number | null} removed
 * @property {ChangeNode[]} [children] Groups only.
 */

/** @type {Record<GitFileKind, { letter: string, label: string, color: string }>} */
const STATUS = {
  modified: { letter: 'M', label: 'Modified', color: 'var(--md-primary)' },
  typeChanged: { letter: 'M', label: 'Type changed', color: 'var(--md-primary)' },
  renamed: { letter: 'R', label: 'Renamed', color: 'var(--md-primary)' },
  added: { letter: 'A', label: 'Added', color: 'var(--vcs-add)' },
  untracked: { letter: 'U', label: 'Untracked', color: 'var(--vcs-add)' },
  deleted: { letter: 'D', label: 'Deleted', color: 'var(--md-error)' },
  conflicted: { letter: '!', label: 'Conflicted', color: 'var(--md-error)' },
};

/** @type {Record<ChangeGroup, string>} */
const GROUP_TITLES = { changes: 'Changes', untracked: 'Untracked files' };

/**
 * @param {number | null} a
 * @param {number | null} b
 */
function sum(a, b) {
  return a === null ? b : b === null ? a : a + b;
}

/**
 * Groups changed files like `git status`: tracked changes, then untracked files; each sorted by
 * path, with line counts summed per group. Empty groups are left out.
 * @param {GitFileStatus[]} files
 * @returns {ChangeNode[]}
 */
function buildGroups(files) {
  /** @type {Record<ChangeGroup, ChangeNode[]>} */
  const byGroup = { changes: [], untracked: [] };
  for (const file of files) {
    const id = file.path;
    const slash = id.lastIndexOf('/');
    byGroup[file.kind === 'untracked' ? 'untracked' : 'changes'].push({
      id,
      label: slash === -1 ? id : id.slice(slash + 1),
      dir: slash === -1 ? '' : id.slice(0, slash),
      file,
      added: file.added,
      removed: file.removed,
    });
  }
  /** @type {ChangeGroup[]} */
  const order = ['changes', 'untracked'];
  return order
    .filter((group) => byGroup[group].length > 0)
    .map((group) => {
      const children = byGroup[group].sort((a, b) => a.id.localeCompare(b.id));
      /** @type {number | null} */
      let added = null;
      /** @type {number | null} */
      let removed = null;
      for (const child of children) {
        added = sum(added, child.added);
        removed = sum(removed, child.removed);
      }
      return { id: `group:${group}`, label: GROUP_TITLES[group], dir: '', file: null, added, removed, children };
    });
}

/**
 * @tag acp-changes-panel
 * @summary Working-tree changes in checkable groups, with the commit message, Amend and Commit.
 * @fires acp-diff-open `{ path }` A changed file's name was clicked: show its diff in the Changes tab.
 * @fires acp-commit-select `{ ids }` The files picked for the commit.
 * @fires acp-changes-refresh `null`
 * @fires acp-amend-start `null` Amend was turned on: `fillAmendMessage()` gets the last commit's message.
 * @fires acp-commit `{ paths, message, amend }` Answered by `commitFinished()`.
 */
export class AcpChangesPanel extends LitElement {
  static properties = {
    changes: { attribute: false },
    repo: { attribute: false },
    selection: { attribute: false },
    root: { attribute: false },
    message: { state: true },
    amend: { state: true },
    committing: { state: true },
  };

  static styles = styles;

  /** @type {ChangeNode[]} */
  #nodes = [];
  /** @type {Map<string, ChangeNode>} Files (what a commit takes) by id. */
  #leaves = new Map();
  /** @type {Set<string>} Ids of the groups. */
  #groupIds = new Set();
  /** @type {Set<string>} Groups the user collapsed; the others stay expanded across refreshes. */
  #collapsed = new Set();
  /** The tree must get its checks and expansion after the next render. */
  #syncTree = false;
  /**
   * While the tree takes new items and our checks, its own selection events describe a passing
   * state (e.g. new items with nothing checked yet) and must not overwrite the selection.
   */
  #syncing = false;
  /** The message typed before Amend replaced it, restored when Amend is turned off. */
  #draft = '';

  constructor() {
    super();
    /** @type {GitChangesView} */
    this.changes = { files: [], loaded: false, loading: false, error: null };
    /** @type {GitRepoView} */
    this.repo = { repo: null, error: null };
    /** @type {ReadonlySet<string>} Picked here or in the Changes tab: the tree follows either. */
    this.selection = new Set();
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {string} */
    this.message = '';
    /** @type {boolean} */
    this.amend = false;
    /** @type {boolean} A commit is running: the form is locked. */
    this.committing = false;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    const old = changed.get('changes');
    if (changed.has('changes') && (this.changes.files !== old?.files || this.changes.loaded !== old?.loaded)) {
      this.#rebuild();
    }
    if (changed.has('selection')) this.#syncTree = true;
  }

  /**
   * The last commit's message, for Amend; ignored once Amend is off again.
   * @param {string | null} message `null` when there is none.
   */
  fillAmendMessage(message) {
    if (this.amend && message !== null) this.message = message;
  }

  /**
   * The commit `acp-commit` asked for is done; a successful one clears the form.
   * @param {boolean} succeeded
   */
  commitFinished(succeeded) {
    this.committing = false;
    if (!succeeded) return;
    this.message = '';
    this.#draft = '';
    this.amend = false;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Iterable<string>} ids */
  #select(ids) {
    this.#emit('acp-commit-select', { ids: [...ids] });
  }

  updated() {
    if (!this.#syncTree) return;
    this.#syncTree = false;
    this.#applyTreeState();
  }

  get #tree() {
    return this.renderRoot.querySelector('tvx-tree-view');
  }

  /** @returns {string[]} Ids of the files going into the commit. */
  get #included() {
    const selection = this.selection;
    return [...this.#leaves.keys()].filter((id) => selection.has(id));
  }

  /** Rebuilds the list from `changes`, keeping checks and collapsed groups that still exist. */
  #rebuild() {
    this.#nodes = buildGroups(this.changes.files);
    this.#leaves = new Map();
    this.#groupIds = new Set();
    for (const group of this.#nodes) {
      this.#groupIds.add(group.id);
      for (const file of group.children ?? []) this.#leaves.set(file.id, file);
    }
    this.#collapsed = new Set([...this.#collapsed].filter((id) => this.#groupIds.has(id)));
    this.#syncTree = true;
    this.#syncing = true;
  }

  /** Pushes checks and expansion into the tree once it has the new items. */
  async #applyTreeState() {
    const tree = this.#tree;
    if (!tree) {
      this.#syncing = false;
      return;
    }
    this.#syncing = true;
    await tree.updateComplete;
    tree.selectedItems = this.#included;
    tree.expandedItems = [...this.#groupIds].filter((id) => !this.#collapsed.has(id));
    await tree.updateComplete;
    this.#syncing = false;
  }

  /** @param {Event} e */
  #onSelectionChange(e) {
    if (this.#syncing) return;
    const { selectedItems } = /** @type {CustomEvent<{ selectedItems: Set<PropertyKey> }>} */ (e).detail;
    this.#select([...this.#leaves.keys()].filter((id) => selectedItems.has(id)));
  }

  /** @param {Event} e */
  #onExpansionChange(e) {
    if (this.#syncing) return;
    const { expandedItems } = /** @type {CustomEvent<{ expandedItems: Set<PropertyKey> }>} */ (e).detail;
    this.#collapsed = new Set([...this.#groupIds].filter((id) => !expandedItems.has(id)));
  }

  /** The all-files checkbox: everything in unless everything already is, then everything out. */
  #onToggleAll() {
    this.#select(this.#included.length === this.#leaves.size ? [] : this.#leaves.keys());
  }

  /** @param {Event} e */
  #onAmendChange(e) {
    const amend = /** @type {HTMLInputElement} */ (e.target).checked;
    this.amend = amend;
    if (!amend) {
      this.message = this.#draft;
      return;
    }
    this.#draft = this.message;
    this.#emit('acp-amend-start', null);
  }

  /** @param {Event} e */
  #onMessageInput(e) {
    this.message = /** @type {HTMLInputElement} */ (e.target).value;
  }

  /** @param {ChangeNode} node */
  #open(node) {
    if (!node.file) return;
    this.#emit('acp-diff-open', { path: absPath(this.root, node.id) });
  }

  #commit() {
    if (this.committing) return;
    /** @type {string[]} */
    const paths = [];
    for (const id of this.#included) {
      const file = this.#leaves.get(id)?.file;
      if (!file) continue;
      paths.push(file.path);
      if (file.origPath) paths.push(file.origPath);
    }
    this.committing = true;
    this.#emit('acp-commit', { paths, message: this.message.trim(), amend: this.amend });
  }

  /**
   * A file's status letter; nothing for a group. Rendered in the tree's shadow root: styled inline.
   * @param {ChangeNode} node
   */
  #renderLeading = (node) => {
    if (!node.file) return nothing;
    const { letter, label, color } = STATUS[node.file.kind];
    const id = `acp-changes-panel-status:${node.id}`;
    return html`<span
        id=${id}
        style="width: 14px; text-align: center; font: 500 11px/16px var(--font-family-mono); color: ${color}"
        aria-label=${label}
        >${letter}</span
      >
      <md-tooltip for=${id}>${label}</md-tooltip>`;
  };

  /**
   * A group's title and file count, or a file's name followed by its folder.
   * @param {ChangeNode} node
   */
  #renderLabel = (node) => {
    if (!node.file) {
      return html`<span style="display: flex; align-items: center; gap: 6px">
        <span style="font-size: 13px; font-weight: 500; line-height: 20px; color: var(--md-on-surface)"
          >${node.label}</span
        >
        <span
          style="min-width: 20px; height: 20px; box-sizing: border-box; padding: 0 6px; border-radius: 9999px;
            background: var(--md-surface-container-highest); font-size: 11px; font-weight: 500;
            line-height: 20px; text-align: center; font-variant-numeric: tabular-nums;
            color: var(--md-on-surface-variant)"
          >${node.children?.length ?? 0}</span
        >
      </span>`;
    }
    const deleted = node.file.kind === 'deleted';
    const id = `acp-changes-panel-label:${node.id}`;
    return html`<span
        id=${id}
        style="display: flex; align-items: baseline; gap: 6px; min-width: 0"
        @click=${() => this.#open(node)}
      >
        <span
          style="flex: none; font-size: 13px; line-height: 20px;
            color: ${deleted ? 'var(--md-on-surface-variant)' : 'var(--md-on-surface)'};
            ${deleted ? 'text-decoration: line-through;' : ''}"
          >${node.label}</span
        >
        <span
          style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font-size: 11.5px; line-height: 16px; color: var(--md-on-surface-variant)"
          >${node.dir}</span
        >
      </span>
      <!-- width: max-content keeps the tooltip's width independent of its position (see acp-file-tree) -->
      <md-tooltip for=${id} style="width: max-content">${node.file.origPath ? `${node.file.origPath} → ${node.id}` : node.id}</md-tooltip>`;
  };

  /** @param {ChangeNode} node */
  #renderCounts = (node) => {
    const { added, removed } = node;
    if (!added && !removed) return nothing;
    return html`<span
      style="display: flex; gap: 6px; font: 500 11px/16px var(--font-family-mono); font-variant-numeric: tabular-nums"
    >
      ${added ? html`<span style="color: var(--diff-add-fg)">+${added}</span>` : nothing}
      ${removed ? html`<span style="color: var(--diff-del-fg)">−${removed}</span>` : nothing}
    </span>`;
  };

  #renderBody() {
    const { loaded, loading, error } = this.changes;
    if (loading && !loaded) {
      return html`<div class="acp-changes-panel__state">
        <md-progress-circular class="acp-changes-panel__spinner" aria-label="Loading changes"></md-progress-circular>
      </div>`;
    }
    if (error) {
      return html`<div class="acp-changes-panel__state" role="alert">
        <b class="acp-changes-panel__state-title">Couldn't read changes</b><span>${error}</span>
      </div>`;
    }
    if (loaded && !this.repo.repo) {
      return html`<div class="acp-changes-panel__state">
        <b class="acp-changes-panel__state-title">Not a git repository</b>
      </div>`;
    }
    if (this.#leaves.size === 0) {
      return html`<div class="acp-changes-panel__state">
        <md-icon class="acp-changes-panel__state-icon">${unsafeSVG(checkCircleIcon)}</md-icon>
        <b class="acp-changes-panel__state-title">No changes</b>
        <span>The working tree matches HEAD.</span>
      </div>`;
    }
    return html`<tvx-tree-view
      class="acp-changes-panel__tree"
      compact
      checkbox-selection
      expansion-trigger="icon"
      aria-label="Changed files"
      .items=${this.#nodes}
      .renderItemLeading=${this.#renderLeading}
      .renderItemLabel=${this.#renderLabel}
      .renderItemTrailing=${this.#renderCounts}
      @tvx-selection-change=${this.#onSelectionChange}
      @tvx-expansion-change=${this.#onExpansionChange}
    ></tvx-tree-view>`;
  }

  render() {
    const total = this.#leaves.size;
    const included = this.#included.length;
    const summary = total === 0 ? 'No changed files' : `${total} ${total === 1 ? 'file' : 'files'} · ${included} selected`;
    const label = this.committing
      ? 'Committing…'
      : this.amend
        ? 'Amend commit'
        : included > 0
          ? `Commit ${included} ${included === 1 ? 'file' : 'files'}`
          : 'Commit';
    const canCommit = !this.committing && this.message.trim() !== '' && (included > 0 || this.amend);
    return html`
      <div class="acp-changes-panel__tools">
        <md-checkbox
          class="acp-changes-panel__all"
          aria-label="Select all changed files"
          ?disabled=${total === 0}
          .checked=${total > 0 && included === total}
          .indeterminate=${included > 0 && included < total}
          @change=${this.#onToggleAll}
        ></md-checkbox>
        <span class="acp-changes-panel__summary">${summary}</span>
        <span class="acp-changes-panel__spacer"></span>
        <md-icon-button
          class="acp-changes-panel__refresh"
          aria-label="Refresh"
          title="Refresh"
          @click=${() => this.#emit('acp-changes-refresh', null)}
        >
          <md-icon class="acp-changes-panel__refresh-icon">${unsafeSVG(refreshIcon)}</md-icon>
        </md-icon-button>
      </div>
      ${this.#renderBody()}
      <footer class="acp-changes-panel__footer">
        <md-text-field
          class="acp-changes-panel__message"
          variant="outlined"
          multiline
          label="Commit message"
          ?disabled=${this.committing}
          .value=${this.message}
          @input=${this.#onMessageInput}
        ></md-text-field>
        <div class="acp-changes-panel__actions">
          <label class="acp-changes-panel__amend">
            <md-checkbox
              .checked=${this.amend}
              ?disabled=${this.committing}
              @change=${this.#onAmendChange}
            ></md-checkbox>
            Amend
          </label>
          <span class="acp-changes-panel__actions-spacer"></span>
          <md-button class="acp-changes-panel__commit" variant="filled" ?disabled=${!canCommit} @click=${this.#commit}>
            <md-icon slot="icon" class="acp-changes-panel__commit-icon">${unsafeSVG(checkIcon)}</md-icon>
            ${label}
          </md-button>
        </div>
      </footer>
    `;
  }
}

customElements.define('acp-changes-panel', AcpChangesPanel);
