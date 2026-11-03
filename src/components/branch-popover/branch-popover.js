import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { flip, offset, shift } from '@floating-ui/dom';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import arrowDownwardIcon from '@material-design-icons/svg/outlined/arrow_downward.svg?raw';
import arrowUpwardIcon from '@material-design-icons/svg/outlined/arrow_upward.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import cloudIcon from '@material-design-icons/svg/outlined/cloud.svg?raw';
import cloudUploadIcon from '@material-design-icons/svg/outlined/cloud_upload.svg?raw';
import contentCopyIcon from '@material-design-icons/svg/outlined/content_copy.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import forkRightIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import syncIcon from '@material-design-icons/svg/outlined/sync.svg?raw';
import { FloatingController } from '../../controllers/floating/FloatingController.js';
import { git } from '../../hooks/git/git.js';
import styles from './branch-popover.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */
/** @typedef {import('../../hooks/git/types.js').GitBranchList} GitBranchList */
/** @typedef {import('../../hooks/git/types.js').GitFetchError} GitFetchError */

/** @type {Record<string, string>} The chip's icons by name. */
const ICONS = { arrow_downward: arrowDownwardIcon, arrow_upward: arrowUpwardIcon, cloud_upload: cloudUploadIcon };

/**
 * @tag acp-branch-popover
 * @summary The header's branch button and the card it opens: the branch with a Copy button, how it stands against its remote with the chip's action and Fetch, a new branch, and the local and remote branches to switch to.
 * @fires acp-git-branches-query `null` The card opened: the container answers with `branches`.
 * @fires acp-git-switch `{ branch, create, remote? }` A branch picked (a remote one with its remote), or a new one named; the container answers with `switchFinished()`.
 * @fires acp-git-remote `{ action }` The remote action of the chip, or Fetch.
 * @fires acp-copy `{ text }` The branch's name.
 */
export class AcpBranchPopover extends LitElement {
  static properties = {
    repo: { attribute: false },
    branches: { attribute: false },
    fetchError: { attribute: false },
    open: { state: true },
    filter: { state: true },
    creating: { state: true },
    error: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GitRepoState | null} */
    this.repo = null;
    /** @type {GitBranchList | null} The lists, once the container has answered the query. */
    this.branches = null;
    /** @type {GitFetchError | null} Why the last background fetch failed, told beside the remote. */
    this.fetchError = null;
    /** @type {boolean} The card is showing. */
    this.open = false;
    /** @type {string} */
    this.filter = '';
    /** @type {boolean} The new branch's name field is showing. */
    this.creating = false;
    /** @type {string | null} Why the last switch was refused. */
    this.error = null;
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

  /**
   * The container's answer to a switch.
   * @param {string | null} error `null`: it worked and the card closes; else why git refused, shown in the card.
   */
  switchFinished(error) {
    if (error === null) this.#popover?.hidePopover();
    else this.error = error;
  }

  // Before the card shows, so it is placed before its first paint.
  #onToggle = (/** @type {Event} */ e) => {
    this.open = /** @type {ToggleEvent} */ (e).newState === 'open';
    if (this.open) {
      this.#emit('acp-git-branches-query', null);
      this.updateComplete.then(() => this.#field('.acp-branch-popover__filter')?.focus());
    } else {
      this.#closedAt = performance.now();
      this.filter = '';
      this.creating = false;
      this.error = null;
    }
  };

  /** @param {string} selector */
  #field(selector) {
    return /** @type {HTMLElement | null} */ (this.renderRoot.querySelector(selector));
  }

  /**
   * @param {string} type
   * @param {unknown} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {string} action */
  #ask(action) {
    this.#popover?.hidePopover();
    this.#emit('acp-git-remote', { action });
  }

  /**
   * @param {string} branch
   * @param {boolean} create
   * @param {string} [remote] A remote branch's remote: a tracking branch of it is made.
   */
  #switch(branch, create, remote) {
    this.error = null;
    this.#emit('acp-git-switch', { branch, create, ...(remote ? { remote } : {}) });
  }

  #onTrigger() {
    if (performance.now() - this.#closedAt >= 300) this.#popover?.togglePopover();
  }

  #onNew() {
    this.creating = true;
    this.updateComplete.then(() => this.#field('.acp-branch-popover__name')?.focus());
  }

  #onNameKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Enter') return;
    const name = /** @type {HTMLInputElement} */ (e.currentTarget).value.trim();
    if (name) this.#switch(name, true);
  };

  /** @param {GitRepoState} repo */
  #renderFacts(repo) {
    const chip = git.remoteChip(repo, Date.now(), null, this.fetchError);
    // A synced branch's click is a fetch, which has a button of its own.
    const primary = chip?.action && chip.id !== 'synced' ? chip : null;
    return html`<div class="acp-branch-popover__facts">
      <span class="acp-branch-popover__label">Branch</span>
      <span class="acp-branch-popover__branch">${repo.branch ?? ''}</span>
      <md-icon-button id="acp-branch-popover-copy" class="acp-branch-popover__copy" aria-label="Copy branch name" @click=${() => this.#emit('acp-copy', { text: repo.branch })}>
        <md-icon class="acp-branch-popover__copy-icon">${unsafeSVG(contentCopyIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-branch-popover-copy" show-delay="800">Copy branch name</md-tooltip>
      <span class="acp-branch-popover__label">Remote</span>
      <span class="acp-branch-popover__remote">${chip?.tooltip ?? ''}</span>
    </div>
    <div class="acp-branch-popover__actions">
      ${primary
        ? html`<md-button class="acp-branch-popover__button acp-branch-popover__primary" variant="tonal" @click=${() => this.#ask(/** @type {string} */ (primary.action))}>
            <md-icon slot="icon" class="acp-branch-popover__icon">${unsafeSVG(ICONS[primary.icon] ?? '')}</md-icon>
            ${primary.label}
          </md-button>`
        : nothing}
      ${repo.remote
        ? html`<md-button class="acp-branch-popover__button acp-branch-popover__fetch" variant="outlined" @click=${() => this.#ask('fetch')}>
            <md-icon slot="icon" class="acp-branch-popover__icon">${unsafeSVG(syncIcon)}</md-icon>
            Fetch
          </md-button>`
        : nothing}
      <md-button class="acp-branch-popover__button acp-branch-popover__new" variant="outlined" @click=${() => this.#onNew()}>
        <md-icon slot="icon" class="acp-branch-popover__icon">${unsafeSVG(addIcon)}</md-icon>
        New branch…
      </md-button>
    </div>
    ${this.creating
      ? html`<label class="acp-branch-popover__search">
          <md-icon class="acp-branch-popover__icon">${unsafeSVG(forkRightIcon)}</md-icon>
          <input
            class="acp-branch-popover__name"
            type="text"
            placeholder="New branch name"
            aria-label="New branch name"
            spellcheck="false"
            @keydown=${this.#onNameKey}
          />
        </label>`
      : nothing}`;
  }

  #renderBranches() {
    if (!this.branches) return nothing;
    const rows = git.branchRows(this.branches, this.filter, Date.now());
    return html`<label class="acp-branch-popover__search">
        <md-icon class="acp-branch-popover__icon">${unsafeSVG(searchIcon)}</md-icon>
        <input
          class="acp-branch-popover__filter"
          type="text"
          placeholder="Switch branch"
          aria-label="Switch branch"
          spellcheck="false"
          .value=${live(this.filter)}
          @input=${(/** @type {Event} */ e) => (this.filter = /** @type {HTMLInputElement} */ (e.target).value)}
        />
      </label>
      ${this.error ? html`<p class="acp-branch-popover__error" role="alert">${this.error}</p>` : nothing}
      <div class="acp-branch-popover__list">
        ${rows.local.length ? html`<span class="acp-branch-popover__heading">Local</span>` : nothing}
        ${repeat(
          rows.local,
          (row) => row.name,
          (row) => html`<button
            type="button"
            class="acp-branch-popover__row ${row.current ? 'acp-branch-popover__row_current' : ''}"
            aria-current=${row.current ? 'true' : nothing}
            @click=${() => (row.current ? this.#popover?.hidePopover() : this.#switch(row.name, false))}
          >
            <md-icon class="acp-branch-popover__icon">${unsafeSVG(row.current ? checkIcon : forkRightIcon)}</md-icon>
            <span class="acp-branch-popover__name-text">${row.name}</span>
            <span class="acp-branch-popover__detail">${row.detail}</span>
          </button>`,
        )}
        ${rows.remote.length ? html`<span class="acp-branch-popover__heading">Remote</span>` : nothing}
        ${repeat(
          rows.remote,
          (row) => `${row.remote}/${row.name}`,
          (row) => html`<button type="button" class="acp-branch-popover__row" @click=${() => this.#switch(row.name, false, row.remote)}>
            <md-icon class="acp-branch-popover__icon">${unsafeSVG(cloudIcon)}</md-icon>
            <span class="acp-branch-popover__name-text">${row.name}</span>
            <span class="acp-branch-popover__detail">${row.remote}</span>
          </button>`,
        )}
      </div>`;
  }

  render() {
    const repo = this.repo;
    if (!repo) return nothing;
    const name = repo.detached ? (repo.sha?.slice(0, 7) ?? 'HEAD') : (repo.branch ?? '');
    const title = [repo.detached ? `Detached HEAD at ${repo.sha ?? ''}` : `Branch ${repo.branch}`, repo.upstream ? `tracking ${repo.upstream}` : 'no upstream']
      .filter(Boolean)
      .join(', ');
    return html`<button
        id="acp-branch-popover"
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
      <md-tooltip for="acp-branch-popover" show-delay="800" placement="bottom">${title}</md-tooltip>
      <div class="acp-branch-popover__popover" popover="auto" role="dialog" aria-label="Branch" @beforetoggle=${this.#onToggle}>
        ${repo.branch ? this.#renderFacts(repo) : nothing} ${this.#renderBranches()}
      </div>`;
  }
}

customElements.define('acp-branch-popover', AcpBranchPopover);
