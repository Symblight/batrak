import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import '../branch-picker/branch-picker.js';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import computerIcon from '@material-design-icons/svg/outlined/computer.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import workspaceIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import styles from './run-target.css?inline';

/** @typedef {import('../../hooks/composer/types.js').RunTarget} RunTarget */
/** @typedef {import('../../hooks/git/types.js').BranchList} BranchList */

/** @type {BranchList} */
const NO_BRANCHES = { local: [], remotes: [], default: null };

const BUTTON_ID = 'acp-run-target-button';

/**
 * @tag acp-run-target
 * @summary A draft's composer footer: where its first message creates the chat (This workspace, New worktree from a base branch, or Local).
 * @fires acp-run-target-change `{ target }` A `RunTarget` picked: a place, or New worktree's base.
 */
export class AcpRunTarget extends LitElement {
  static properties = {
    target: { attribute: false },
    workspaceName: { attribute: false },
    worktrees: { attribute: false },
    branches: { attribute: false },
    base: { attribute: false },
    loadBranches: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {RunTarget} */
    this.target = { kind: 'local' };
    /** @type {string | null} The worktree workspace the draft is of; `null` in Main (no This workspace). */
    this.workspaceName = null;
    /** @type {boolean} New worktree is offered: the project can have workspaces. */
    this.worktrees = true;
    /** @type {BranchList} Main's, for New worktree's base. */
    this.branches = NO_BRANCHES;
    /** @type {string | null} New worktree's base as shown: the picked one or Main's default. */
    this.base = null;
    /** @type {(() => Promise<void>) | null} Runs before the base menu opens (the branches fetched). */
    this.loadBranches = null;
  }

  /** @param {RunTarget} target */
  #change(target) {
    this.dispatchEvent(new CustomEvent('acp-run-target-change', { detail: { target }, bubbles: true, composed: true }));
  }

  // A pick reaches this twice: from the item, then re-dispatched by its menu.
  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (value === 'worktree') this.#change({ kind: 'worktree', base: null });
    else if (value === 'workspace' || value === 'local') this.#change({ kind: value });
  };

  #onBranchPick = (/** @type {Event} */ e) => {
    e.stopPropagation();
    this.#change({ kind: 'worktree', base: /** @type {CustomEvent<{ branch: string }>} */ (e).detail.branch });
  };

  /** The places offered, in order: This workspace only in a worktree workspace, New worktree where the project can have workspaces. */
  get #places() {
    return [
      ...(this.workspaceName !== null
        ? [{ kind: 'workspace', label: 'This workspace', button: this.workspaceName, about: this.workspaceName, icon: workspaceIcon }]
        : []),
      ...(this.worktrees
        ? [{ kind: 'worktree', label: 'New worktree', button: 'New worktree', about: 'A new workspace on its own branch', icon: branchIcon }]
        : []),
      { kind: 'local', label: 'Local', button: 'Local', about: 'The project folder (Main)', icon: computerIcon },
    ];
  }

  render() {
    const places = this.#places;
    const place = places.find((p) => p.kind === this.target.kind) ?? places[places.length - 1];
    return html`<md-button id=${BUTTON_ID} class="acp-run-target__button" variant="text">
        <md-icon slot="icon" class="acp-run-target__icon">${unsafeSVG(place.icon)}</md-icon>
        ${place.button}
        <md-icon class="acp-run-target__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-tooltip for=${BUTTON_ID} show-delay="800">Where the new chat runs</md-tooltip>
      <md-menu
        class="acp-run-target__menu"
        for=${BUTTON_ID}
        placement="bottom-start"
        focus-on-open="selected"
        aria-label="Where the new chat runs"
        @select=${this.#onSelect}
      >
        ${places.map(
          (p) => html`<md-menu-item value=${p.kind} ?selected=${p === place}>
            <md-icon slot="leading">${unsafeSVG(p.icon)}</md-icon>
            ${p.label}
            <span slot="supporting-text">${p.about}</span>
          </md-menu-item>`,
        )}
      </md-menu>
      ${place.kind === 'worktree'
        ? html`<acp-branch-picker
            class="acp-run-target__base"
            .list=${this.branches}
            .value=${this.base}
            .load=${this.loadBranches}
            @acp-branch-pick=${this.#onBranchPick}
          ></acp-branch-picker>`
        : nothing}`;
  }
}

customElements.define('acp-run-target', AcpRunTarget);
