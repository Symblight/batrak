import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import editNoteIcon from '@material-design-icons/svg/outlined/edit_note.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import loginIcon from '@material-design-icons/svg/outlined/login.svg?raw';
import mergeIcon from '@material-design-icons/svg/outlined/merge.svg?raw';
import mergeTypeIcon from '@material-design-icons/svg/outlined/merge_type.svg?raw';
import { github } from '../../hooks/github/github.js';
import styles from './pull-request-chip.css?inline';

/** @typedef {import('../../hooks/github/types.js').GithubSlot} GithubSlot */
/** @typedef {import('../../hooks/github/types.js').GithubPrReply} GithubPrReply */
/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */

/** @type {Record<string, string>} */
const ICONS = { add: addIcon, close: closeIcon, edit_note: editNoteIcon, merge: mergeIcon, merge_type: mergeTypeIcon };

/**
 * @tag acp-pull-request-chip
 * @summary The header's GitHub slot for a branch whose remote is on github.com: how to sign in while the GitHub CLI is signed out, the branch's pull request with its checks (or Create PR), or that the account has no access.
 * @fires acp-github-open `{ url }` The pull request, or GitHub's page to create one.
 */
export class AcpPullRequestChip extends LitElement {
  static properties = {
    status: { attribute: false },
    reply: { attribute: false },
    repo: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GithubSlot} */
    this.status = 'hidden';
    /** @type {GithubPrReply | null} The lookup of the shown branch's pull request. */
    this.reply = null;
    /** @type {GitRepoState | null} */
    this.repo = null;
  }

  /**
   * @param {string} event
   * @param {unknown} [detail]
   */
  #emit(event, detail = null) {
    this.dispatchEvent(new CustomEvent(event, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {{ label: string, tooltip: string, icon: string, mod?: string, dot?: string | null, click?: (() => void) | null }} chip
   * @param {boolean} [disabled]
   */
  #chip({ label, tooltip, icon, mod = '', dot = null, click = null }, disabled = false) {
    const content = html`<md-icon class="acp-pull-request-chip__icon">${unsafeSVG(icon)}</md-icon>${label}${dot
        ? html`<span class="acp-pull-request-chip__dot" data-checks=${dot}></span>`
        : nothing}`;
    const classes = `acp-pull-request-chip__button ${click ? mod : 'acp-pull-request-chip__button_static'}`;
    return html`${click
        ? html`<button id="acp-pull-request-chip" class=${classes} type="button" ?disabled=${disabled} @click=${click}>${content}</button>`
        : html`<span id="acp-pull-request-chip" class=${classes}>${content}</span>`}
      <md-tooltip for="acp-pull-request-chip" show-delay="800" placement="bottom">${tooltip}</md-tooltip>`;
  }

  /** The branch's pull request, or Create PR. */
  #renderBranch() {
    const reply = this.reply;
    if (reply?.status !== 'ok' || !this.repo) return nothing;
    if (reply.pr) {
      const { url } = reply.pr;
      const chip = github.prChip(reply.pr);
      const stale = reply.stale !== undefined;
      return this.#chip({
        label: chip.label,
        tooltip: stale ? `Couldn't reach GitHub: ${reply.stale}; retrying` : chip.tooltip,
        icon: ICONS[chip.icon] ?? '',
        mod: `acp-pull-request-chip__button_${chip.state}${stale ? ' acp-pull-request-chip__button_stale' : ''}`,
        dot: chip.checks,
        click: () => this.#emit('acp-github-open', { url }),
      });
    }
    const create = github.createPr(this.repo, reply.defaultBranch);
    const { url } = create;
    return this.#chip(
      { label: 'Create PR', tooltip: create.tooltip, icon: addIcon, mod: 'acp-pull-request-chip__button_create', click: () => url && this.#emit('acp-github-open', { url }) },
      url === null,
    );
  }

  render() {
    switch (this.status) {
      case 'signedOut':
        return this.#chip({ label: 'Not signed in', tooltip: 'Sign in to GitHub to see this branch’s pull request: run gh auth login in a terminal.', icon: loginIcon });
      case 'noAccess':
        return this.#chip({ label: 'No access', tooltip: 'The signed-in GitHub account can’t see this repository. Sign in with another account: run gh auth login in a terminal.', icon: lockIcon });
      case 'ok':
        return this.#renderBranch();
      default:
        return nothing;
    }
  }
}

customElements.define('acp-pull-request-chip', AcpPullRequestChip);
