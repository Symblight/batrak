import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import computerIcon from '@material-design-icons/svg/outlined/computer.svg?raw';
import containerIcon from '@material-design-icons/svg/outlined/inventory_2.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import publicIcon from '@material-design-icons/svg/outlined/public.svg?raw';
import { configOf } from '../../models/config-options/config-options.js';
import styles from './run-target.css?inline';

/** @typedef {import('../../models/types/types.js').RunTargetKind} RunTargetKind */
/** @typedef {import('../../models/types/types.js').RunTarget} RunTarget */
/** @typedef {import('../../models/types/types.js').ComposerState} ComposerState */
/** @typedef {import('../../models/types/types.js').LocalTurns} LocalTurns */

/** @type {readonly { kind: RunTargetKind, label: string, description: string, icon: string, disabled?: boolean }[]} */
const KINDS = [
  { kind: 'local', label: 'Local', description: 'Runs directly in this workspace', icon: computerIcon },
  { kind: 'worktree', label: 'New worktree', description: 'A separate working copy and branch', icon: branchIcon },
  { kind: 'docker', label: 'Docker', description: 'Isolated container (not available yet)', icon: containerIcon, disabled: true },
];

/**
 * @tag acp-run-target
 * @summary The composer's footer: where the session runs (Local / Worktree / Docker) and, for a worktree, the branch it starts from; read-only once it started.
 * @fires acp-run-target-change `{ patch }` A `Partial<RunTarget>`.
 * @fires acp-branches-query `{}` when the branch menu opens; answered through `branches`.
 */
export class AcpRunTarget extends LitElement {
  static properties = {
    composer: { attribute: false },
    branches: { attribute: false },
    currentBranch: { attribute: false },
    localShared: { attribute: false },
    localTurns: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {ComposerState | null} The active session's. */
    this.composer = null;
    /** @type {readonly string[]} Branches a worktree can start from; the current one is added. */
    this.branches = [];
    /** @type {string | null} The project's checked-out branch. */
    this.currentBranch = null;
    /** @type {number} Other local sessions of the project with a running agent. */
    this.localShared = 0;
    /** @type {LocalTurns} */
    this.localTurns = 'queue';
  }

  /** @param {typeof KINDS[number]} kind */
  #description(kind) {
    if (kind.kind !== 'local' || this.localShared === 0) return kind.description;
    const n = this.localShared;
    const turns = this.localTurns === 'parallel' ? 'Turns run at once' : 'Turns wait for each other';
    return `Shared with ${n} running session${n === 1 ? '' : 's'}. ${turns}`;
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

  #onBranchesQuery = () => {
    this.dispatchEvent(new CustomEvent('acp-branches-query', { detail: {}, bubbles: true, composed: true }));
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
      <md-button
        id="acp-run-target-branch"
        class="acp-run-target__button"
        variant="text"
        @click=${this.#onBranchesQuery}
      >
        <md-icon slot="icon" class="acp-run-target__icon">${unsafeSVG(branchIcon)}</md-icon>
        ${branch}
        <md-icon class="acp-run-target__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-tooltip for="acp-run-target-branch" show-delay="800">Branch the worktree starts from</md-tooltip>
      <md-menu
        class="acp-run-target__menu"
        for="acp-run-target-branch"
        placement="bottom-start"
        focus-on-open="selected"
        @select=${this.#onBranchSelect}
      >
        <md-menu-group label="Start from">
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
    const mode = configOf(configOptions, 'mode');
    // Its risk, which the backend tagged it with (the agent's crate knows its modes).
    const fullAccess = mode?.options.find((v) => v.value === mode.currentValue)?.risk === 'full';
    const note = fullAccess
      ? html`<span class="acp-run-target__note">
          <md-icon class="acp-run-target__note-icon">${unsafeSVG(publicIcon)}</md-icon>
          Network and files outside the workspace
        </span>`
      : nothing;

    if (started) {
      return html`
        <span id="acp-run-target-fixed-kind" class="acp-run-target__fixed">
          <md-icon class="acp-run-target__icon">${unsafeSVG(kind.icon)}</md-icon>${label}
        </span>
        <md-tooltip for="acp-run-target-fixed-kind" show-delay="800">Fixed for this session</md-tooltip>
        ${branch
          ? html`<span id="acp-run-target-fixed-branch" class="acp-run-target__fixed">
                <md-icon class="acp-run-target__icon">${unsafeSVG(branchIcon)}</md-icon>${branch}
                <md-icon class="acp-run-target__icon">${unsafeSVG(lockIcon)}</md-icon>
              </span>
              <md-tooltip for="acp-run-target-fixed-branch" show-delay="800">Fixed for this session</md-tooltip>`
          : nothing}
        ${note}
      `;
    }
    return html`
      <md-button id="acp-run-target-kind" class="acp-run-target__button" variant="text">
        <md-icon slot="icon" class="acp-run-target__icon">${unsafeSVG(kind.icon)}</md-icon>
        ${label}
        <md-icon class="acp-run-target__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-tooltip for="acp-run-target-kind" show-delay="800">Where the agent runs</md-tooltip>
      <md-menu
        class="acp-run-target__menu"
        for="acp-run-target-kind"
        placement="bottom-start"
        focus-on-open="selected"
        @select=${this.#onKindSelect}
      >
        ${KINDS.map(
          (k) => html`
            <md-menu-item
              class="acp-run-target__item"
              value=${k.kind}
              ?selected=${k.kind === kind.kind}
              ?disabled=${k.disabled ?? false}
            >
              <md-icon slot="leading">${unsafeSVG(k.icon)}</md-icon>
              ${k.label}
              <span slot="supporting-text">${this.#description(k)}</span>
            </md-menu-item>
          `,
        )}
      </md-menu>
      ${kind.kind === 'worktree' ? this.#renderBranchMenu(branch ?? 'HEAD') : nothing} ${note}
    `;
  }
}

customElements.define('acp-run-target', AcpRunTarget);
