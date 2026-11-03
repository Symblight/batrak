import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/segmented-button';
import '@symblight/wc-material/text-field';
import '../branch-picker/branch-picker.js';
import '../shortcut/shortcut.js';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import folderIcon from '@material-design-icons/svg/outlined/home.svg?raw';
import projectIcon from '@material-design-icons/svg/outlined/inventory_2.svg?raw';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import { app } from '../../hooks/app/app.js';
import styles from './workspace-dialog.css?inline';

/** @typedef {Pick<import('../../hooks/projects/types.js').Project, 'id' | 'name'>} ProjectChoice */
/** @typedef {import('../../hooks/git/types.js').BranchList} BranchList */
/** @typedef {'isolated' | 'project'} WorkspaceMode */

const PROJECT_ID = 'acp-workspace-dialog-project';

const MODES = /** @type {const} */ ([
  {
    value: 'isolated',
    label: 'Isolated workspace',
    icon: branchIcon,
    about: 'A separate checkout on its own new branch. Files, chats, changes, and terminals stay scoped to it.',
  },
  {
    value: 'project',
    label: 'Project folder',
    icon: folderIcon,
    about: 'Runs directly in your project folder — no isolation. Changes land on the current branch.',
  },
]);

/** @type {BranchList} */
const NO_BRANCHES = { local: [], remotes: [], default: null };

/**
 * A field's native `select` (its text selected) bubbles like md-menu's pick: it mustn't reach the menu.
 * @param {Event} e
 */
const stopSelect = (e) => e.stopPropagation();

/**
 * Mod+Enter: Create.
 * @param {KeyboardEvent} e
 */
const isCreateKey = (e) => e.key === 'Enter' && (app.platform === 'mac' ? e.metaKey : e.ctrlKey);

/**
 * @tag acp-workspace-dialog
 * @summary Create workspace: an isolated workspace (an optional name, its own branch from a picked one) or the project folder, in a picked project; Create (or Mod+Enter) works at once and shows a new chat of it.
 * @fires acp-workspace-create `{ mode, baseBranch, name }` `baseBranch` and `name` are `null` in the project folder, `name` too when none was typed.
 * @fires acp-branches-query `{}` As it opens and once another project is shown; answered through `branches`.
 * @fires acp-project-select `{ projectId }` Another project picked: the container shows it.
 */
export class AcpWorkspaceDialog extends LitElement {
  static properties = {
    projects: { attribute: false },
    projectPath: { attribute: false },
    branches: { attribute: false },
    mainBranch: { attribute: false },
    fetchBranches: { attribute: false },
    mode: { state: true },
    base: { state: true },
    name: { state: true },
    projectFilter: { state: true },
    pickedProject: { state: true },
  };

  static styles = styles;

  /** It's open: a project shown meanwhile is the one to create in. */
  #open = false;
  /** The branches were fetched since it opened (or another project was shown). */
  #fetched = false;
  /** A branch was picked since then: the default no longer follows the branches as they arrive. */
  #picked = false;

  constructor() {
    super();
    /** @type {readonly ProjectChoice[]} */
    this.projects = [];
    /** @type {string | null} The shown project, which it creates in. */
    this.projectPath = null;
    /** @type {BranchList} The shown project's. */
    this.branches = NO_BRANCHES;
    /** @type {string | null} Main's checked-out branch: the default without a remote default. */
    this.mainBranch = null;
    /** @type {(() => Promise<void>) | null} Fetches the shown project's branches and lists them again. */
    this.fetchBranches = null;
    /** @type {WorkspaceMode} */
    this.mode = 'isolated';
    /** @type {string | null} The picked branch; `null` until the branches say the default. */
    this.base = null;
    /** @type {string} */
    this.projectFilter = '';
    /** @type {string} An isolated workspace's name; empty: named after its branch until its first chat names it. */
    this.name = '';
    /** @type {string | null} The project picked in its menu; Create waits until it's the shown one. */
    this.pickedProject = null;
  }

  /** @returns {HTMLElementTagNameMap['md-dialog']} */
  get #dialog() {
    return /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog'));
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Opens it with everything prefilled. */
  async show() {
    this.mode = 'isolated';
    this.base = null;
    this.name = '';
    this.pickedProject = null;
    this.#open = true;
    this.#fetched = false;
    this.#picked = false;
    this.#emit('acp-branches-query', {});
    await this.updateComplete;
    await this.#dialog.show();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    // Another project shown while it's open: its branches, from its default.
    if (this.#open && typeof changed.get('projectPath') === 'string') {
      this.#fetched = false;
      this.#picked = false;
      this.#emit('acp-branches-query', {});
    }
    // The branches arrive after it opens (and after a fetch): the default follows them until a pick.
    if (!this.#picked && (this.base === null || changed.has('branches') || changed.has('mainBranch'))) {
      this.base = this.branches.default ?? this.mainBranch ?? this.branches.local[0] ?? null;
    }
  }

  #close() {
    void this.#dialog.close();
  }

  /** A picked project is shown, and an isolated workspace has a branch to start from. */
  get #ready() {
    const shown = this.pickedProject === null || this.pickedProject === this.projectPath;
    return shown && (this.mode !== 'isolated' || this.base !== null);
  }

  #create() {
    if (!this.#ready) return;
    const isolated = this.mode === 'isolated';
    this.#emit('acp-workspace-create', {
      mode: this.mode,
      baseBranch: isolated ? this.base : null,
      name: isolated && this.name.trim() !== '' ? this.name.trim() : null,
    });
    this.#close();
  }

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (!isCreateKey(e)) return;
    e.preventDefault();
    this.#create();
  };

  // The branch menu's first opening since it opened (or another project was shown) waits for a fetch.
  #loadBranches = async () => {
    if (this.#fetched || this.fetchBranches === null) return;
    this.#fetched = true;
    await this.fetchBranches();
  };

  #onBranchPick = (/** @type {Event} */ e) => {
    this.#picked = true;
    this.base = /** @type {CustomEvent<{ branch: string }>} */ (e).detail.branch;
  };

  #onProjectPick = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    this.pickedProject = value;
    if (value !== this.projectPath) this.#emit('acp-project-select', { projectId: value });
  };

  // The field keeps its typing; ArrowDown goes to the first row, the menu's arrows from there; Escape
  // and Mod+Enter (Create) go on to the dialog.
  #onProjectFilterKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' || isCreateKey(e)) return;
    e.stopPropagation();
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    /** @type {HTMLElementTagNameMap['md-menu'] | null} */ (this.renderRoot.querySelector('.acp-workspace-dialog__projects'))?.focusFirstItem();
  };

  #renderProjects() {
    const current = this.projects.find((p) => p.id === this.projectPath) ?? null;
    const query = this.projectFilter.trim().toLowerCase();
    const shown = query ? this.projects.filter((p) => p.name.toLowerCase().includes(query)) : this.projects;
    const icon = html`<md-icon slot="leading" class="acp-workspace-dialog__icon">${unsafeSVG(projectIcon)}</md-icon>`;
    return html`<md-button id=${PROJECT_ID} class="acp-workspace-dialog__picker" variant="outlined">
        <span class="acp-workspace-dialog__label">
          <md-icon class="acp-workspace-dialog__project-icon">${unsafeSVG(projectIcon)}</md-icon>
          <span class="acp-workspace-dialog__project">${current?.name ?? ''}</span>
          <md-icon class="acp-workspace-dialog__icon">${unsafeSVG(expandMoreIcon)}</md-icon>
        </span>
      </md-button>
      <md-menu
        class="acp-workspace-dialog__projects"
        for=${PROJECT_ID}
        placement="bottom-start"
        focus-on-open="selected"
        aria-label="Projects"
        @select=${this.#onProjectPick}
        @opening=${() => (this.projectFilter = '')}
      >
        <div class="acp-workspace-dialog__search">
          <md-icon class="acp-workspace-dialog__icon">${unsafeSVG(searchIcon)}</md-icon>
          <input
            class="acp-workspace-dialog__filter"
            aria-label="Search projects"
            placeholder="Search projects…"
            spellcheck="false"
            .value=${this.projectFilter}
            @input=${(/** @type {Event} */ e) => (this.projectFilter = /** @type {HTMLInputElement} */ (e.target).value)}
            @keydown=${this.#onProjectFilterKeydown}
            @select=${stopSelect}
          />
        </div>
        ${repeat(
          shown,
          (p) => p.id,
          (p) => html`<md-menu-item value=${p.id} ?selected=${p.id === this.projectPath}>${icon}${p.name}</md-menu-item>`,
        )}
      </md-menu>`;
  }

  render() {
    const mode = MODES.find((m) => m.value === this.mode) ?? MODES[0];
    const mac = app.platform === 'mac';
    return html`<md-dialog class="acp-workspace-dialog__dialog" wide @keydown=${this.#onKeydown} @closed=${() => (this.#open = false)}>
      <div slot="headline" class="acp-workspace-dialog__head">
        <h2 class="acp-workspace-dialog__headline">Create workspace</h2>
        <p class="acp-workspace-dialog__subtitle">${mode.about}</p>
      </div>
      <div class="acp-workspace-dialog__content">
        <md-segmented-button-group
          class="acp-workspace-dialog__modes"
          label="Where it runs"
          .value=${this.mode}
          @change=${(/** @type {CustomEvent<{ value: WorkspaceMode }>} */ e) => (this.mode = e.detail.value)}
        >
          ${MODES.map(
            (m) => html`<md-segmented-button class="acp-workspace-dialog__mode" value=${m.value}>
              <md-icon slot="icon" class="acp-workspace-dialog__icon">${unsafeSVG(m.icon)}</md-icon>
              ${m.label}
            </md-segmented-button>`,
          )}
        </md-segmented-button-group>
        ${this.mode === 'isolated'
          ? html`<md-text-field
              class="acp-workspace-dialog__name"
              variant="outlined"
              label="Name (optional)"
              spellcheck="false"
              .value=${this.name}
              @input=${(/** @type {Event} */ e) => (this.name = /** @type {HTMLInputElement} */ (e.target).value)}
            ></md-text-field>`
          : nothing}
        <div class="acp-workspace-dialog__row">
          ${this.#renderProjects()}
          ${this.mode === 'isolated'
            ? html`<acp-branch-picker
                .list=${this.branches}
                .value=${this.base}
                .load=${this.#loadBranches}
                @acp-branch-pick=${this.#onBranchPick}
              ></acp-branch-picker>`
            : nothing}
        </div>
      </div>
      <div slot="footer" class="acp-workspace-dialog__footer">
        <span class="acp-workspace-dialog__spacer"></span>
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__cancel" variant="text" @click=${() => this.#close()}>Cancel</md-button>
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__create" variant="filled" trailing-icon ?disabled=${!this.#ready} @click=${() => this.#create()}>
          Create
          <acp-shortcut slot="icon" class="acp-workspace-dialog__key">${mac ? '⌘↵' : 'Ctrl+↵'}</acp-shortcut>
        </md-button>
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-workspace-dialog', AcpWorkspaceDialog);
