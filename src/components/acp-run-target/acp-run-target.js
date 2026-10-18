import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import computerIcon from '@material-design-icons/svg/outlined/computer.svg?raw';
import containerIcon from '@material-design-icons/svg/outlined/inventory_2.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import publicIcon from '@material-design-icons/svg/outlined/public.svg?raw';
import { configOf } from '../../models/config-options.js';
import styles from './acp-run-target.css?inline';

/** @typedef {import('../../models/types.js').RunTargetKind} RunTargetKind */
/** @typedef {import('../../models/types.js').RunTarget} RunTarget */
/** @typedef {import('../../models/types.js').ComposerState} ComposerState */

/** @type {readonly { kind: RunTargetKind, label: string, description: string, icon: string }[]} */
const KINDS = [
  { kind: 'local', label: 'Local', description: 'Runs directly in this workspace', icon: computerIcon },
  { kind: 'worktree', label: 'New worktree', description: 'A separate working copy and branch', icon: branchIcon },
  { kind: 'docker', label: 'Docker', description: 'Isolated container', icon: containerIcon },
];

/**
 * @tag acp-run-target
 * @summary The composer's footer: where the session runs (Local / Worktree / Docker) and on which branch; read-only once it started.
 * @fires acp-run-target-change `{ patch }` A `Partial<RunTarget>`.
 */
export class AcpRunTarget extends LitElement {
  static properties = {
    composer: { attribute: false },
    branches: { attribute: false },
    currentBranch: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {ComposerState | null} The active session's. */
    this.composer = null;
    /** @type {readonly string[]} Branches to pick from; the current one is added. */
    this.branches = [];
    /** @type {string | null} The project's checked-out branch. */
    this.currentBranch = null;
  }

  /** @param {Partial<RunTarget>} patch */
  #change(patch) {
    this.dispatchEvent(new CustomEvent('acp-run-target-change', { detail: { patch }, bubbles: true, composed: true }));
  }

  // Picks reach these twice: from the item, then re-dispatched by its menu.
  #onKindSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    this.#change({ kind: /** @type {RunTargetKind} */ (value) });
  };

  #onBranchSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    this.#change({ branch: value === this.currentBranch ? null : value });
  };

  /** @param {string} branch */
  #renderBranchMenu(branch) {
    const names = this.branches.includes(branch) ? this.branches : [branch, ...this.branches];
    return html`
      <md-button id="acp-run-target-branch" class="acp-run-target__button" variant="text" title="Branch">
        <md-icon slot="icon" class="acp-run-target__icon">${unsafeSVG(branchIcon)}</md-icon>
        ${branch}
        <md-icon class="acp-run-target__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-menu
        class="acp-run-target__menu"
        for="acp-run-target-branch"
        placement="bottom-start"
        focus-on-open="selected"
        @select=${this.#onBranchSelect}
      >
        <md-menu-group label="Branch">
          ${names.map(
            (name) => html`
              <md-menu-item class="acp-run-target__item" value=${name} ?selected=${name === branch}>${name}</md-menu-item>
            `,
          )}
        </md-menu-group>
      </md-menu>
    `;
  }

  render() {
    if (!this.composer) return nothing;
    const { runTarget, started, configOptions } = this.composer;
    const kind = KINDS.find((k) => k.kind === runTarget.kind) ?? KINDS[0];
    const label = kind.kind === 'worktree' && started ? 'Worktree' : kind.label;
    const branch = runTarget.branch ?? this.currentBranch;
    const fullAccess = configOf(configOptions, 'mode')?.currentValue === 'full';
    const note = fullAccess
      ? html`<span class="acp-run-target__note">
          <md-icon class="acp-run-target__note-icon">${unsafeSVG(publicIcon)}</md-icon>
          Network and files outside the workspace
        </span>`
      : nothing;

    if (started) {
      return html`
        <span class="acp-run-target__fixed" title="Fixed for this session">
          <md-icon class="acp-run-target__icon">${unsafeSVG(kind.icon)}</md-icon>${label}
        </span>
        ${branch
          ? html`<span class="acp-run-target__fixed" title="Fixed for this session">
              <md-icon class="acp-run-target__icon">${unsafeSVG(branchIcon)}</md-icon>${branch}
              <md-icon class="acp-run-target__icon">${unsafeSVG(lockIcon)}</md-icon>
            </span>`
          : nothing}
        ${note}
      `;
    }
    return html`
      <md-button id="acp-run-target-kind" class="acp-run-target__button" variant="text" title="Where the agent runs">
        <md-icon slot="icon" class="acp-run-target__icon">${unsafeSVG(kind.icon)}</md-icon>
        ${label}
        <md-icon class="acp-run-target__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-menu
        class="acp-run-target__menu"
        for="acp-run-target-kind"
        placement="bottom-start"
        focus-on-open="selected"
        @select=${this.#onKindSelect}
      >
        ${KINDS.map(
          (k) => html`
            <md-menu-item class="acp-run-target__item" value=${k.kind} ?selected=${k.kind === kind.kind}>
              <md-icon slot="leading">${unsafeSVG(k.icon)}</md-icon>
              ${k.label}
              <span slot="supporting-text">${k.description}</span>
            </md-menu-item>
          `,
        )}
      </md-menu>
      ${branch ? this.#renderBranchMenu(branch) : nothing} ${note}
    `;
  }
}

customElements.define('acp-run-target', AcpRunTarget);
