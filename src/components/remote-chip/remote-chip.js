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
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import { git } from '../../hooks/git/git.js';
import styles from './remote-chip.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../hooks/git/types.js').GitRemoteOp} GitRemoteOp */

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
 * @fires acp-git-remote `{ action: 'fetch' | 'pull' | 'push' | 'publish' | 'dismiss' }`
 */
export class AcpRemoteChip extends LitElement {
  static properties = {
    repo: { attribute: false },
    op: { attribute: false },
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
  #closedAt = 0;

  willUpdate() {
    this.state = git.remoteChip(this.repo, Date.now(), this.op)?.id ?? null;
  }

  // Before the popover shows, so it is placed before its first paint.
  #onToggle = (/** @type {Event} */ e) => {
    this.open = /** @type {ToggleEvent} */ (e).newState === 'open';
    if (!this.open) this.#closedAt = performance.now();
  };

  /** @param {string} action */
  #ask(action) {
    this.#popover?.hidePopover();
    this.dispatchEvent(new CustomEvent('acp-git-remote', { detail: { action }, bubbles: true, composed: true }));
  }

  #onChipClick(/** @type {string | null} */ action) {
    if (action) {
      this.#ask(action);
    } else if (performance.now() - this.#closedAt >= 300) {
      this.#popover?.togglePopover();
    }
  }

  #renderFailure() {
    const op = this.op;
    if (op?.state !== 'failed' || !op.error) return nothing;
    const { action, error } = op;
    const title = git.remoteChip(this.repo, Date.now(), op)?.label ?? '';
    return html`<div class="acp-remote-chip__popover" popover="auto" role="dialog" aria-label=${title} @beforetoggle=${this.#onToggle}>
      <p class="acp-remote-chip__title">${title}</p>
      <pre class="acp-remote-chip__message">${error.message}</pre>
      <div class="acp-remote-chip__actions">
        <md-button variant="text" @click=${() => this.#ask(action)}>Retry</md-button>
        ${error.kind === 'rejected' ? html`<md-button variant="text" @click=${() => this.#ask('pull')}>Pull</md-button>` : nothing}
        <md-button variant="text" @click=${() => this.#ask('dismiss')}>Dismiss</md-button>
      </div>
    </div>`;
  }

  render() {
    const chip = git.remoteChip(this.repo, Date.now(), this.op);
    if (!chip) return nothing;
    const failed = chip.id === 'failed';
    const content = html`${chip.id === 'busy'
      ? html`<md-progress-circular class="acp-remote-chip__spinner"></md-progress-circular>`
      : chip.icon
        ? html`<md-icon class="acp-remote-chip__icon">${unsafeSVG(ICONS[chip.icon] ?? '')}</md-icon>`
        : nothing}${chip.label}`;
    const chipElement =
      chip.action || failed
        ? html`<button
            id="acp-remote-chip"
            class="acp-remote-chip__chip acp-remote-chip__chip_action"
            type="button"
            aria-haspopup=${failed ? 'dialog' : nothing}
            aria-expanded=${failed ? String(this.open) : nothing}
            @click=${() => this.#onChipClick(chip.action)}
          >
            ${content}
          </button>`
        : html`<span id="acp-remote-chip" class="acp-remote-chip__chip">${content}</span>`;
    return html`${chipElement}
      <md-tooltip for="acp-remote-chip" show-delay="800" placement="bottom">${chip.tooltip}</md-tooltip>
      ${this.#renderFailure()}`;
  }
}

customElements.define('acp-remote-chip', AcpRemoteChip);
