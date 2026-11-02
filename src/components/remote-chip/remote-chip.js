import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import arrowDownwardIcon from '@material-design-icons/svg/outlined/arrow_downward.svg?raw';
import arrowUpwardIcon from '@material-design-icons/svg/outlined/arrow_upward.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import cloudUploadIcon from '@material-design-icons/svg/outlined/cloud_upload.svg?raw';
import swapVertIcon from '@material-design-icons/svg/outlined/swap_vert.svg?raw';
import { git } from '../../hooks/git/git.js';
import styles from './remote-chip.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoState} GitRepoState */

/** @type {Record<string, string>} */
const ICONS = {
  arrow_downward: arrowDownwardIcon,
  arrow_upward: arrowUpwardIcon,
  check: checkIcon,
  cloud_upload: cloudUploadIcon,
  swap_vert: swapVertIcon,
};

/**
 * @tag acp-remote-chip
 * @summary The branch's sync with its remote as a compact status chip: what to push or pull, "Publish" without an upstream, "No remote"; nothing for a detached HEAD.
 */
export class AcpRemoteChip extends LitElement {
  static properties = {
    repo: { attribute: false },
    state: { reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GitRepoState | null} */
    this.repo = null;
    /** @type {string | null} The chip's state, for styling. */
    this.state = null;
  }

  willUpdate() {
    this.state = git.remoteChip(this.repo, Date.now())?.id ?? null;
  }

  render() {
    const chip = git.remoteChip(this.repo, Date.now());
    if (!chip) return nothing;
    return html`<span id="acp-remote-chip" class="acp-remote-chip__chip">
        ${chip.icon ? html`<md-icon class="acp-remote-chip__icon">${unsafeSVG(ICONS[chip.icon] ?? '')}</md-icon>` : nothing}${chip.label}
      </span>
      <md-tooltip for="acp-remote-chip" show-delay="800" placement="bottom">${chip.tooltip}</md-tooltip>`;
  }
}

customElements.define('acp-remote-chip', AcpRemoteChip);
