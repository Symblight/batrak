import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { flip, offset, shift } from '@floating-ui/dom';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import cancelIcon from '@material-design-icons/svg/outlined/cancel.svg?raw';
import checkCircleIcon from '@material-design-icons/svg/outlined/check_circle.svg?raw';
import contentCopyIcon from '@material-design-icons/svg/outlined/content_copy.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import forkRightIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import mergeTypeIcon from '@material-design-icons/svg/outlined/merge_type.svg?raw';
import openInNewIcon from '@material-design-icons/svg/outlined/open_in_new.svg?raw';
import pendingIcon from '@material-design-icons/svg/outlined/pending.svg?raw';
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import { git } from '../../hooks/git/git.js';
import { github } from '../../hooks/github/github.js';
import styles from './branch-popover.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../hooks/github/types.js').GithubPullRequest} GithubPullRequest */

/** @type {Record<string, string>} */
const PR_STATES = { draft: 'Draft', open: 'Open', merged: 'Merged', closed: 'Closed' };

/** @type {Record<'ok' | 'fail' | 'run', string>} */
const CHECK_ICONS = { ok: checkCircleIcon, fail: cancelIcon, run: pendingIcon };

/**
 * @tag acp-branch-popover
 * @summary The header's branch button and the card it opens: the branch with a Copy button, how it stands against its remote, and its pull request with its checks.
 * @fires acp-copy `{ text }` The branch's name.
 * @fires acp-github-open `{ url }` The pull request.
 */
export class AcpBranchPopover extends LitElement {
  static properties = {
    repo: { attribute: false },
    pr: { attribute: false },
    open: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GitRepoState | null} */
    this.repo = null;
    /** @type {GithubPullRequest | null} The branch's pull request, once looked up. */
    this.pr = null;
    /** @type {boolean} The card is showing. */
    this.open = false;
  }

  get #popover() {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-branch-popover__popover'));
  }

  // Constructed after the fields above: the controller reads them on every update.
  #floating = new FloatingController(this, {
    floating: () => (this.open ? this.#popover : null),
    reference: () => /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-branch-popover__trigger')),
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });

  /** When light dismiss last closed the card: the press on the button that caused it mustn't reopen it. */
  #closedAt = -Infinity;

  // Before the card shows, so it is placed before its first paint.
  #onToggle = (/** @type {Event} */ e) => {
    this.open = /** @type {ToggleEvent} */ (e).newState === 'open';
    if (!this.open) this.#closedAt = performance.now();
  };

  #onTrigger() {
    if (performance.now() - this.#closedAt >= 300) this.#popover?.togglePopover();
  }

  /**
   * @param {string} type
   * @param {unknown} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {GitRepoState} repo */
  #renderBranch(repo) {
    return html`<span class="acp-branch-popover__label">Branch</span>
      <span class="acp-branch-popover__value acp-branch-popover__value_mono">${repo.branch ?? `Detached at ${repo.sha?.slice(0, 7) ?? 'HEAD'}`}</span>
      ${repo.branch
        ? html`<md-icon-button id="acp-branch-popover-copy" class="acp-branch-popover__action acp-branch-popover__copy" aria-label="Copy branch name" @click=${() => this.#emit('acp-copy', { text: repo.branch })}>
              <md-icon class="acp-branch-popover__action-icon">${unsafeSVG(contentCopyIcon)}</md-icon>
            </md-icon-button>
            <md-tooltip for="acp-branch-popover-copy" show-delay="800">Copy branch name</md-tooltip>`
        : html`<span></span>`}`;
  }

  /** @param {GithubPullRequest} pr */
  #renderPullRequest(pr) {
    const chip = github.prChip(pr);
    const checks = github.checksLine(pr);
    return html`<span class="acp-branch-popover__label">Pull request</span>
      <span class="acp-branch-popover__value">
        <md-icon class="acp-branch-popover__icon acp-branch-popover__pr_${chip.state}">${unsafeSVG(mergeTypeIcon)}</md-icon>
        PR #${pr.number} · ${PR_STATES[chip.state]}
      </span>
      <md-icon-button id="acp-branch-popover-open" class="acp-branch-popover__action acp-branch-popover__open" aria-label="Open on GitHub" @click=${() => this.#emit('acp-github-open', { url: pr.url })}>
        <md-icon class="acp-branch-popover__action-icon">${unsafeSVG(openInNewIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-branch-popover-open" show-delay="800">Open on GitHub</md-tooltip>
      ${checks
        ? html`<span class="acp-branch-popover__label">Checks</span>
            <span class="acp-branch-popover__value">
              <md-icon class="acp-branch-popover__icon acp-branch-popover__checks_${checks.state}">${unsafeSVG(CHECK_ICONS[checks.state])}</md-icon>
              ${checks.text}
            </span>
            <span></span>`
        : nothing}`;
  }

  render() {
    const repo = this.repo;
    if (!repo) return nothing;
    const name = repo.detached ? (repo.sha?.slice(0, 7) ?? 'HEAD') : (repo.branch ?? '');
    return html`<button
        type="button"
        class="acp-branch-popover__trigger"
        aria-haspopup="dialog"
        aria-expanded=${String(this.open)}
        @click=${() => this.#onTrigger()}
      >
        <md-icon class="acp-branch-popover__icon">${unsafeSVG(forkRightIcon)}</md-icon>
        <span class="acp-branch-popover__trigger-name">${name}</span>
        <md-icon class="acp-branch-popover__icon acp-branch-popover__chevron ${this.open ? 'acp-branch-popover__chevron_open' : ''}">${unsafeSVG(expandMoreIcon)}</md-icon>
      </button>
      <div class="acp-branch-popover__popover" popover="auto" role="dialog" aria-label="Branch" @beforetoggle=${this.#onToggle}>
        <div class="acp-branch-popover__rows">
          ${this.#renderBranch(repo)}
          <span class="acp-branch-popover__label">Remote</span>
          <span class="acp-branch-popover__value">${git.remoteLine(repo)}</span>
          <span></span>
          ${this.pr ? this.#renderPullRequest(this.pr) : nothing}
        </div>
      </div>`;
  }
}

customElements.define('acp-branch-popover', AcpBranchPopover);
