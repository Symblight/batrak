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
 * @tag acp-workspace-dialog
 * @summary Create workspace: an isolated workspace (its own branch from a picked one) or the project folder, in a picked project, with an optional first message; Create (or Mod+Enter) works at once.
 * @fires acp-workspace-create `{ mode, baseBranch, prompt }` `baseBranch` is `null` in the project folder, `prompt` when nothing was typed.
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
    prompt: { state: true },
    projectFilter: { state: true },
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
    this.prompt = '';
    /** @type {string} */
    this.projectFilter = '';
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
    this.prompt = '';
    this.#open = true;
    this.#fetched = false;
    this.#picked = false;
    this.#emit('acp-branches-query', {});
    await this.updateComplete;
    await this.#dialog.show();
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-workspace-dialog__prompt'))?.focus();
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

  #create() {
    const prompt = this.prompt.trim();
    const isolated = this.mode === 'isolated';
    this.#emit('acp-workspace-create', {
      mode: this.mode,
      baseBranch: isolated ? this.base : null,
      prompt: prompt === '' ? null : prompt,
    });
    this.#close();
  }

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    const mod = app.platform === 'mac' ? e.metaKey : e.ctrlKey;
    if (e.key !== 'Enter' || !mod) return;
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
    if (value !== this.projectPath) this.#emit('acp-project-select', { projectId: value });
  };

  // The field keeps its typing; ArrowDown goes to the first row, the menu's arrows from there.
  #onProjectFilterKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') return;
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
        <md-text-field
          class="acp-workspace-dialog__prompt"
          variant="outlined"
          multiline
          aria-label="What do you want to work on?"
          placeholder="What do you want to work on?"
          .value=${this.prompt}
          @input=${(/** @type {Event} */ e) => (this.prompt = /** @type {HTMLInputElement} */ (e.target).value)}
        ></md-text-field>
      </div>
      <div slot="footer" class="acp-workspace-dialog__footer">
        <span class="acp-workspace-dialog__spacer"></span>
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__cancel" variant="text" @click=${() => this.#close()}>Cancel</md-button>
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__create" variant="filled" trailing-icon @click=${() => this.#create()}>
          Create
          <acp-shortcut slot="icon" class="acp-workspace-dialog__key">${mac ? '⌘↵' : 'Ctrl+↵'}</acp-shortcut>
        </md-button>
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-workspace-dialog', AcpWorkspaceDialog);
