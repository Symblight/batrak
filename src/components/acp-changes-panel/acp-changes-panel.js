import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/tree-view';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/text-field';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import checkCircleIcon from '@material-design-icons/svg/outlined/check_circle.svg?raw';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { gitController } from '../../services/git-controller.js';
import { gitLastCommitMessage } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { $commitSelection, $gitChanges, $gitRepo, setCommitSelection } from '../../stores/git.js';
import styles from './acp-changes-panel.css?inline';

/** @typedef {import('../../models/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../models/types.js').GitFileKind} GitFileKind */
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
 * @summary Working-tree changes in checkable groups, with the commit message, Amend and Commit; kept current while active.
 * @fires acp-diff-open `{ path }` A changed file's name was clicked: show its diff in the Changes tab.
 * @fires acp-commit `{ paths, message, amend }` Commit was pressed; `paths` are root-relative.
 */
export class AcpChangesPanel extends LitElement {
  static properties = {
    active: { type: Boolean },
    message: { state: true },
    amend: { state: true },
  };

  static styles = styles;

  #changes = new StoreController(this, {
    store: $gitChanges,
    onChange: (changes, old) => {
      if (changes.files !== old?.files || changes.loaded !== old?.loaded) this.#rebuild();
    },
  });
  #repo = new StoreController(this, { store: $gitRepo });
  /** Picked in this panel or the Changes tab: the tree follows either. */
  #selection = new StoreController(this, {
    store: $commitSelection,
    onChange: () => {
      this.#syncTree = true;
    },
  });
  /** @type {(() => void) | null} Stops watching; set while active and connected. */
  #unwatch = null;
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
    /** @type {boolean} Shown in the side pane: changes are computed and kept current. */
    this.active = false;
    /** @type {string} */
    this.message = '';
    /** @type {boolean} */
    this.amend = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.active) this.#watch();
  }

  disconnectedCallback() {
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
    if (!this.#syncTree) return;
    this.#syncTree = false;
    this.#applyTreeState();
  }

  get #tree() {
    return this.renderRoot.querySelector('tvx-tree-view');
  }

  /** @returns {string[]} Ids of the files going into the commit. */
  get #included() {
    const selection = this.#selection.value;
    return [...this.#leaves.keys()].filter((id) => selection.has(id));
  }

  #watch() {
    this.#unwatch ??= gitController.watchChanges();
  }

  #stopWatching() {
    this.#unwatch?.();
    this.#unwatch = null;
  }

  /** Rebuilds the list from `$gitChanges`, keeping checks and collapsed groups that still exist. */
  #rebuild() {
    this.#nodes = buildGroups(this.#changes.value.files);
    this.#leaves = new Map();
    this.#groupIds = new Set();
    for (const group of this.#nodes) {
      this.#groupIds.add(group.id);
      for (const file of group.children ?? []) this.#leaves.set(file.id, file);
    }
    // Forget picks of files no longer changed; not while a scan is pending, when the list is empty.
    if (this.#changes.value.loaded) setCommitSelection(this.#included);
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
    setCommitSelection([...this.#leaves.keys()].filter((id) => selectedItems.has(id)));
  }

  /** @param {Event} e */
  #onExpansionChange(e) {
    if (this.#syncing) return;
    const { expandedItems } = /** @type {CustomEvent<{ expandedItems: Set<PropertyKey> }>} */ (e).detail;
    this.#collapsed = new Set([...this.#groupIds].filter((id) => !expandedItems.has(id)));
  }

  /** The all-files checkbox: everything in unless everything already is, then everything out. */
  #onToggleAll() {
    setCommitSelection(this.#included.length === this.#leaves.size ? [] : this.#leaves.keys());
  }

  /** @param {Event} e */
  async #onAmendChange(e) {
    const amend = /** @type {HTMLInputElement} */ (e.target).checked;
    this.amend = amend;
    if (!amend) {
      this.message = this.#draft;
      return;
    }
    this.#draft = this.message;
    const rootId = projectController.rootId;
    const last = rootId ? await gitLastCommitMessage(rootId).catch(() => null) : null;
    if (this.amend && last !== null) this.message = last;
  }

  /** @param {Event} e */
  #onMessageInput(e) {
    this.message = /** @type {HTMLInputElement} */ (e.target).value;
  }

  /** @param {ChangeNode} node */
  #open(node) {
    if (!node.file) return;
    this.dispatchEvent(
      new CustomEvent('acp-diff-open', {
        detail: { path: projectController.absPath(node.id) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #commit() {
    /** @type {string[]} */
    const paths = [];
    for (const id of this.#included) {
      const file = this.#leaves.get(id)?.file;
      if (!file) continue;
      paths.push(file.path);
      if (file.origPath) paths.push(file.origPath);
    }
    this.dispatchEvent(
      new CustomEvent('acp-commit', {
        detail: { paths, message: this.message.trim(), amend: this.amend },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * A file's status letter; nothing for a group. Rendered in the tree's shadow root: styled inline.
   * @param {ChangeNode} node
   */
  #renderLeading = (node) => {
    if (!node.file) return nothing;
    const { letter, label, color } = STATUS[node.file.kind];
    return html`<span
      style="width: 14px; text-align: center; font: 500 11px/16px var(--font-family-mono); color: ${color}"
      title=${label}
      aria-label=${label}
      >${letter}</span
    >`;
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
    return html`<span
      style="display: flex; align-items: baseline; gap: 6px; min-width: 0"
      title=${node.file.origPath ? `${node.file.origPath} → ${node.id}` : node.id}
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
    </span>`;
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
    const { loaded, loading, error } = this.#changes.value;
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
    if (loaded && !this.#repo.value.repo) {
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
    const label = this.amend
      ? 'Amend commit'
      : included > 0
        ? `Commit ${included} ${included === 1 ? 'file' : 'files'}`
        : 'Commit';
    const canCommit = this.message.trim() !== '' && (included > 0 || this.amend);
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
          @click=${() => gitController.refreshChanges()}
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
          .value=${this.message}
          @input=${this.#onMessageInput}
        ></md-text-field>
        <div class="acp-changes-panel__actions">
          <label class="acp-changes-panel__amend">
            <md-checkbox .checked=${this.amend} @change=${this.#onAmendChange}></md-checkbox>
            Amend
          </label>
          <span class="acp-changes-panel__spacer"></span>
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
