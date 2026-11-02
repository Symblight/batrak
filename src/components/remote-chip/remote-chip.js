import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { flip, offset, shift } from '@floating-ui/dom';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import arrowDownwardIcon from '@material-design-icons/svg/outlined/arrow_downward.svg?raw';
import arrowUpwardIcon from '@material-design-icons/svg/outlined/arrow_upward.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import cloudUploadIcon from '@material-design-icons/svg/outlined/cloud_upload.svg?raw';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import swapVertIcon from '@material-design-icons/svg/outlined/swap_vert.svg?raw';
import '../confirm-dialog/confirm-dialog.js';
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import { git } from '../../hooks/git/git.js';
import styles from './remote-chip.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../hooks/git/types.js').GitRemoteOp} GitRemoteOp */
/** @typedef {import('../../hooks/git/types.js').GitFetchError} GitFetchError */

/** @type {Record<string, string>} */
const ICONS = {
  arrow_downward: arrowDownwardIcon,
  arrow_upward: arrowUpwardIcon,
  check: checkIcon,
  cloud_upload: cloudUploadIcon,
  error: errorIcon,
  swap_vert: swapVertIcon,
};

/**
 * @tag acp-remote-chip
 * @summary The branch's sync with its remote as a compact chip: what to push or pull (a click does it), "Publish" without an upstream, "No remote", busy while an operation runs, and after a failure a popover with git's message and what to do about it; nothing for a detached HEAD.
 * @fires acp-git-remote `{ action, expected? }` `action` is a `GitRemoteAction`, `'showChanges'` or `'dismiss'`; `expected` (`forcePush`) is the upstream commit it replaces.
 */
export class AcpRemoteChip extends LitElement {
  static properties = {
    repo: { attribute: false },
    op: { attribute: false },
    fetchError: { attribute: false },
    state: { reflect: true },
    open: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GitRepoState | null} */
    this.repo = null;
    /** @type {GitRemoteOp | null} The operation running or failed for this branch's root. */
    this.op = null;
    /** @type {GitFetchError | null} Why the last background fetch failed. */
    this.fetchError = null;
    /** @type {string | null} The chip's state, for styling. */
    this.state = null;
    /** @type {boolean} The failure popover is showing. */
    this.open = false;
  }

  get #popover() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-remote-chip__popover'));
  }

  get #chipElement() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-remote-chip__chip'));
  }

  // Constructed after the fields above: the controller reads them on every update.
  #floating = new FloatingController(this, {
    floating: () => (this.open ? this.#popover : null),
    reference: () => this.#chipElement,
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });

  /** When light dismiss last closed the popover: the press on the chip that caused it mustn't reopen it. */
  #closedAt = -Infinity;

  willUpdate() {
    this.state = git.remoteChip(this.repo, Date.now(), this.op)?.id ?? null;
  }

  // Before the popover shows, so it is placed before its first paint.
  #onToggle = (/** @type {Event} */ e) => {
    this.open = /** @type {ToggleEvent} */ (e).newState === 'open';
    if (!this.open) this.#closedAt = performance.now();
  };

  /**
   * @param {string} action
   * @param {string | null} [expected]
   */
  #ask(action, expected = null) {
    this.#popover?.hidePopover();
    this.dispatchEvent(
      new CustomEvent('acp-git-remote', { detail: { action, ...(expected ? { expected } : {}) }, bubbles: true, composed: true }),
    );
  }

  /** Replaces the remote branch with the local one: asked first, with the commits that would be lost. */
  async #forcePush() {
    const repo = this.repo;
    if (!repo) return;
    this.#popover?.hidePopover();
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.renderRoot.querySelector('acp-confirm-dialog'));
    const upstream = repo.upstream ?? 'the remote branch';
    const plural = (/** @type {number} */ n) => `${n} commit${n === 1 ? '' : 's'}`;
    const confirmed = await dialog.confirm({
      headline: 'Force push?',
      message: `Replace ${upstream} with your ${plural(repo.ahead)}? The ${plural(repo.behind)} only on ${upstream} will be lost.`,
      detail: 'If it has moved since you last fetched, the push is refused instead.',
      confirmLabel: 'Force push',
      destructive: true,
    });
    if (confirmed) this.#ask('forcePush', repo.upstreamSha);
  }

  #onChipClick(/** @type {string | null} */ action) {
    if (action) {
      this.#ask(action);
    } else if (performance.now() - this.#closedAt >= 300) {
      this.#popover?.togglePopover();
    }
  }

  #renderPopover() {
    const op = this.op;
    if (op?.state === 'failed' && op.error) {
      const { action, error } = op;
      const title = git.remoteChip(this.repo, Date.now(), op)?.label ?? '';
      // A pull stopped on a conflict can't just run again: look at it, or give it up.
      const conflict = error.kind === 'conflict';
      return html`<div class="acp-remote-chip__popover" popover="auto" role="dialog" aria-label=${title} @beforetoggle=${this.#onToggle}>
        <p class="acp-remote-chip__title">${title}</p>
        <pre class="acp-remote-chip__message">${error.message}</pre>
        <div class="acp-remote-chip__actions">
          ${conflict
            ? html`<md-button variant="text" @click=${() => this.#ask('showChanges')}>Show Changes</md-button>
                <md-button variant="text" @click=${() => this.#ask('abort')}>Abort</md-button>`
            : html`<md-button variant="text" @click=${() => this.#ask(action)}>Retry</md-button>`}
          ${error.kind === 'rejected' ? html`<md-button variant="text" @click=${() => this.#ask('pull')}>Pull</md-button>` : nothing}
          <md-button variant="text" @click=${() => this.#ask('dismiss')}>Dismiss</md-button>
        </div>
      </div>`;
    }
    if (this.state !== 'diverged') return nothing;
    return html`<div class="acp-remote-chip__popover acp-remote-chip__popover_menu" popover="auto" role="dialog" aria-label="Diverged from the remote" @beforetoggle=${this.#onToggle}>
      <md-button variant="text" @click=${() => this.#ask('pullRebase')}>Pull with rebase</md-button>
      <md-button variant="text" @click=${() => this.#ask('pullMerge')}>Pull with merge</md-button>
      <md-button variant="text" @click=${() => void this.#forcePush()}>Force push…</md-button>
    </div>`;
  }

  render() {
    const chip = git.remoteChip(this.repo, Date.now(), this.op, this.fetchError);
    if (!chip) return nothing;
    const failed = chip.id === 'failed';
    const menu = failed || chip.id === 'diverged';
    const content = html`${chip.id === 'busy'
      ? html`<md-progress-circular class="acp-remote-chip__spinner"></md-progress-circular>`
      : chip.icon
        ? html`<md-icon class="acp-remote-chip__icon">${unsafeSVG(ICONS[chip.icon] ?? '')}</md-icon>`
        : nothing}${chip.label}`;
    const chipElement =
      chip.action || menu
        ? html`<button
            id="acp-remote-chip"
            class="acp-remote-chip__chip acp-remote-chip__chip_action"
            type="button"
            aria-haspopup=${menu ? 'dialog' : nothing}
            aria-expanded=${menu ? String(this.open) : nothing}
            @click=${() => this.#onChipClick(chip.action)}
          >
            ${content}
          </button>`
        : html`<span id="acp-remote-chip" class="acp-remote-chip__chip">${content}</span>`;
    return html`${chipElement}
      <md-tooltip for="acp-remote-chip" show-delay="800" placement="bottom">${chip.tooltip}</md-tooltip>
      ${this.#renderPopover()}
      <acp-confirm-dialog></acp-confirm-dialog>`;
  }
}

customElements.define('acp-remote-chip', AcpRemoteChip);
